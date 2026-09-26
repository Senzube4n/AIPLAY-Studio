import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {createAvatarRoutes} from './avatar.js';
import {createPngtuberSessions, PNGTUBER_LIMITS} from './pngtuber.js';
import {pngtuberTools} from '../mcp-pngtuber.js';
import {frameKind, audioLevel, nextSpeechState} from '../../web/pngtuber-level.js';

const present={frame:'idle',source:'mic',staged:true,visible:true};

test('PNG/WebP signatures and RMS speech hysteresis reject noise without flicker',()=>{
  assert.equal(frameKind(Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0])),'png');
  assert.equal(frameKind(Uint8Array.from(Buffer.from('RIFF1234WEBP'))),'webp');
  assert.equal(frameKind(Uint8Array.from(Buffer.from('<svg>'))),null);
  assert.ok(Math.abs(audioLevel(new Float32Array([0.1,-0.1,0.1,-0.1]))-0.1)<1e-6);
  let state=nextSpeechState(null,0.02,0.045,0);
  assert.equal(state.talking,false);
  state=nextSpeechState(state,0.05,0.045,10);
  assert.equal(state.talking,true);
  state=nextSpeechState(state,0.03,0.045,60);
  assert.equal(state.talking,true,'speech below the start threshold stays open');
  state=nextSpeechState(state,0,0.045,170);
  assert.equal(state.talking,true,'brief silence is held');
  state=nextSpeechState(state,0,0.045,181);
  assert.equal(state.talking,false,'silence eventually closes the mouth');
});

test('agent cue begins only after browser acknowledgement and cannot extend the browser lease',()=>{
  let clock=1000;
  const service=createPngtuberSessions({now:()=>clock}),session_id=randomUUID(),command_id=randomUUID();
  assert.equal(service.register({session_id}).revision,0);
  assert.throws(()=>service.command({session_id,op:'talk',duration_ms:500}),{status:409},'unacknowledged frame session is not an agent cue target');
  service.heartbeat({session_id,applied_revision:0,status:present});
  service.heartbeat({session_id,applied_revision:0,status:{...present,staged:false}});
  assert.equal(service.sessions().sessions[0].status.staged,false,'the visible setup preview can be cued');
  service.heartbeat({session_id,applied_revision:0,status:{...present,visible:false}});
  assert.throws(()=>service.command({session_id,op:'talk',duration_ms:500}),{status:409},'a hidden tab has no visible target');
  service.heartbeat({session_id,applied_revision:0,status:{...present,staged:false}});
  const first=service.command({session_id,command_id,op:'talk',duration_ms:500});
  assert.equal(first.desired.talkingCue.expiresAt,null);
  assert.equal(service.command({session_id,command_id,op:'talk',duration_ms:500}).revision,1,'retry is idempotent');
  assert.throws(()=>service.command({session_id,command_id,op:'clear_talk'}),{status:409});
  clock+=700;
  assert.equal(service.sessions().sessions[0].desired.talkingCue.expiresAt,null,'unseen cue remains pending');
  service.heartbeat({session_id,applied_revision:1,status:{...present,frame:'talking'}});
  assert.equal(service.sessions().sessions[0].desired.talkingCue.expiresAt,clock+500);
  clock+=501;
  assert.equal(service.sessions().sessions[0].desired.talkingCue,null);
  assert.equal(service.command({session_id,op:'clear_talk'}).revision,2);
  assert.throws(()=>service.heartbeat({session_id,applied_revision:0,status:present}),{status:409});
  const expires=service.sessions().sessions[0].expiresAt;
  clock=expires-1;
  service.command({session_id,op:'talk',duration_ms:1000});
  clock=expires;
  assert.throws(()=>service.command({session_id,op:'clear_talk'}),{status:410},'commands do not keep a dead browser live');
});

test('strict commands, bounded live sessions and no image/body fields',()=>{
  let clock=0;
  const service=createPngtuberSessions({now:()=>clock}),session_id=randomUUID();
  service.register({session_id});
  service.heartbeat({session_id,applied_revision:0,status:present});
  for(const input of [
    {session_id,op:'talk',duration_ms:249},
    {session_id,op:'talk',duration_ms:10001},
    {session_id,op:'clear_talk',duration_ms:500},
    {session_id,op:'render',duration_ms:500},
    {session_id,op:'talk',duration_ms:500,image_base64:'bad'},
  ]) assert.throws(()=>service.command(input),{status:400});
  assert.throws(()=>service.heartbeat({session_id,applied_revision:0,status:{...present,url:'https://example.test'}}),{status:400});
  assert.equal(service.sessions().sessions[0].revision,0);
  for(let i=1;i<PNGTUBER_LIMITS.sessions;i++) service.register({session_id:randomUUID()});
  assert.throws(()=>service.register({session_id:randomUUID()}),{status:409});
  clock=PNGTUBER_LIMITS.leaseMs+1;
  assert.deepEqual(service.sessions(),{sessions:[]});
});

async function httpSetup(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'pngtuber-http-'));
  const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  const routes=createAvatarRoutes({directory,json,provenance:{actorFrom:()=> 'test',append:async()=>{}}});
  const server=http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost')).then(handled=>{
    if(!handled){res.writeHead(404);res.end();}
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(body,headers={})=>{
    const response=await fetch(base+'/api/avatars/pngtuber',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  return {base,post,directory};
}

test('guarded HTTP and MCP reach one ephemeral browser session without uploading frames',async t=>{
  const f=await httpSetup(t),session_id=randomUUID(),calls=[];
  assert.equal((await f.post({action:'register',session_id})).status,200);
  assert.equal((await f.post({action:'command',session_id,op:'talk',duration_ms:1000})).status,409);
  await f.post({action:'heartbeat',session_id,applied_revision:0,status:present});
  const tools=pngtuberTools(async(method,route,body)=>{
    calls.push({method,route,body});
    const response=await f.post(body);
    if(response.status!==200)throw Object.assign(new Error(response.body.error),{status:response.status});
    return response.body;
  });
  const run=(name,args={})=>tools.find(tool=>tool.name===name).run(args);
  const cue=await run('pngtuber_talk',{session_id,duration_ms:1000,command_id:randomUUID()});
  assert.equal(cue.revision,1);
  assert.deepEqual(calls.at(-1).body.action,'command');
  assert.deepEqual(calls.at(-1).route,'/api/avatars/pngtuber');
  const received=(await f.post({action:'heartbeat',session_id,applied_revision:0,status:present})).body;
  assert.equal(received.desired.talkingCue.revision,1);
  await f.post({action:'heartbeat',session_id,applied_revision:1,status:{...present,frame:'talking'}});
  const listed=await run('pngtuber_sessions');
  assert.equal(listed.sessions[0].status.frame,'talking');
  assert.equal(listed.sessions[0].applied_revision,1);
  assert.equal((await run('pngtuber_clear_talk',{session_id})).desired.talkingCue,null);
  assert.equal((await f.post({action:'register',session_id,image_base64:'AA=='})).status,400);
  assert.equal((await f.post({action:'sessions'},{Origin:'https://evil.test'})).status,403);
  assert.equal((await f.post({action:'sessions'},{'Sec-Fetch-Site':'cross-site'})).status,403);
  const host=await new Promise((resolve,reject)=>http.request(f.base+'/api/avatars/pngtuber',
    {method:'POST',headers:{Host:'evil.test','Content-Type':'application/json'}},response=>{
      response.resume();response.on('end',()=>resolve(response.statusCode));
    }).on('error',reject).end('{}'));
  assert.equal(host,403);
  assert.match((await f.post({action:'sessions'})).headers.get('cache-control'),/no-store/);
  assert.deepEqual(await readdir(f.directory),[],'no image or session data is written to disk');
});
