import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import * as provenance from '../provenance.js';
import {createAvatarPlayback,PLAYBACK_LIMITS} from './avatar-playback.js';
import {createAvatarRoutes} from './avatar.js';
import {avatarPlaybackTools} from '../mcp-avatar-playback.js';
import {glbDoc,packGlb} from './fixtures.js';

const avatarId='av_12345678-1234-1234-1234-123456789abc';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const clip=Buffer.from('RIFF0000WAVEfmt test data');
async function setup(t){
 const directory=await mkdtemp(path.join(os.tmpdir(),'avatar-playback-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let clock=100000,bytes=Buffer.from('exact source avatar');const ledger={dir:path.join(directory,'ledger')};
 const options={directory,now:()=>clock,inspectAsset:async id=>({row:{id,inspection:{sha256:sha(bytes)}},bytes}),record:event=>provenance.append(ledger,event)};
 const service=createAvatarPlayback(options),session_id=randomUUID();
 const registration={session_id,id:avatarId,sha256:sha(bytes),capabilities:{audio:true,lip_sync:true}};
 const upload=()=>service.upload({name:'voice.wav',data_base64:clip.toString('base64')},'agent:test');
 const command=(op,args={})=>service.command({session_id,command_id:randomUUID(),op,...args},'agent:test');
 return {directory,ledger,service,options,registration,session_id,upload,command,tick:value=>{clock+=value;},change:()=>{bytes=Buffer.from('new avatar');}};
}

test('desired playback survives reload, coalesces load then play, and separates request from browser acknowledgement',async t=>{
 const f=await setup(t);let session=await f.service.register(f.registration,'user');assert.equal(session.revision,0);
 const audio=await f.upload();session=await f.command('load',{audio_id:audio.audio_id});assert.equal(session.desired.playing,false);assert.equal(session.desired.load_revision,1);
 session=await f.command('play');assert.equal(session.revision,2);assert.equal(session.desired.audio_id,audio.audio_id);assert.equal(session.desired.playing,true);assert.equal(session.applied_revision,0);
 const reloaded=createAvatarPlayback(f.options);assert.deepEqual((await reloaded.sessions()).sessions,[session]);
 session=await reloaded.heartbeat({session_id:f.session_id,applied_revision:2,status:{phase:'blocked',time:0,duration:8,error:'Press Play in this browser.'}},'user');
 assert.equal(session.applied_revision,2);assert.equal(session.status.phase,'blocked');assert.equal(session.desired.playing,true);
 session=await f.command('seek',{seconds:3});assert.equal(session.desired.seek_revision,3);assert.equal(session.desired.time,3);
 session=await f.command('pause');assert.equal(session.desired.playing,false);assert.equal(session.desired.time,3);
 session=await f.command('stop');assert.equal(session.desired.time,0);assert.equal(session.desired.seek_revision,5);
 assert.equal((await provenance.verify(f.ledger)).ok,true);
 const events=(await provenance.read(f.ledger)).events;assert.ok(events.every(event=>provenance.EVENT_TYPES.has(event.type)));
 assert.equal(events.find(event=>event.data.op==='playback_command').actor,'agent:test');
});

test('command ids dedupe concurrent retries and reject reuse with different arguments',async t=>{
 const f=await setup(t);await f.service.register(f.registration);const audio=await f.upload();
 const request={session_id:f.session_id,command_id:randomUUID(),op:'load',audio_id:audio.audio_id};
 const results=await Promise.all([f.service.command(request),f.service.command(request)]);assert.ok(results.every(result=>result.revision===1));
 await assert.rejects(f.service.command({...request,op:'play',audio_id:undefined}),{status:409});
 const history=(await provenance.read(f.ledger)).events.filter(event=>event.data.op==='playback_command');assert.equal(history.length,1);
 await f.command('play');assert.equal((await f.service.command(request)).revision,2);
});

test('expired previews disappear and cannot receive commands; commands cannot keep a dead browser alive',async t=>{
 const f=await setup(t);await f.service.register(f.registration);const audio=await f.upload();await f.command('load',{audio_id:audio.audio_id});
 f.tick(20000);await f.command('play');f.tick(10001);
 assert.deepEqual(await f.service.sessions(),{sessions:[]});
 await assert.rejects(f.command('pause'),{status:410});
 await assert.rejects(f.service.heartbeat({session_id:f.session_id,applied_revision:0,status:{phase:'empty',time:0,duration:null}}),{status:410});
 const fresh=await f.service.register(f.registration);assert.equal(fresh.revision,0);assert.equal(fresh.desired.audio_id,null);
});

test('source changes, stale acknowledgements and invalid session capabilities are refused',async t=>{
 const f=await setup(t);await f.service.register(f.registration);const audio=await f.upload();await f.command('load',{audio_id:audio.audio_id});
 const status={phase:'ready',time:0,duration:8};await f.service.heartbeat({session_id:f.session_id,applied_revision:1,status});
 await assert.rejects(f.service.heartbeat({session_id:f.session_id,applied_revision:0,status}),{status:409});
 await assert.rejects(f.service.heartbeat({session_id:f.session_id,applied_revision:2,status}),{status:409});
 await assert.rejects(f.service.register({...f.registration,capabilities:{audio:false,lip_sync:true}}),{status:400});
 await assert.rejects(f.service.register({...f.registration,id:'../outside'}),{status:400});
 f.change();await assert.rejects(f.command('play'),{status:409});
});

test('audio uploads are bounded, opaque, reject paths, expire, and detect same-length byte replacement',async t=>{
 const f=await setup(t);const audio=await f.upload();const {file}=await f.service.media(audio.audio_id);
 assert.ok(file.startsWith(path.join(f.directory,'audio')));assert.equal(audio.sha256,sha(clip));
 await assert.rejects(f.service.upload({name:'../voice.wav',data_base64:'AAAA'}),{status:400});
 await assert.rejects(f.service.upload({name:'script.html',data_base64:'AAAA'}),{status:400});
 await assert.rejects(f.service.upload({name:'voice.wav',data_base64:'AB=='}),{status:413});
 await assert.rejects(f.service.upload({name:'voice.wav',data_base64:'AAAA',path:'C:/secret.wav'}),{status:400});
 await writeFile(file,Buffer.alloc(clip.length));await assert.rejects(f.service.media(audio.audio_id),{status:409});
 f.tick(PLAYBACK_LIMITS.audioMs+1);await assert.rejects(f.service.media(audio.audio_id),{status:410});
 await f.upload();await assert.rejects(readFile(file),{code:'ENOENT'});
});

test('unknown commands and status fields never mutate desired state or provenance',async t=>{
 const f=await setup(t);await f.service.register(f.registration);const before=(await provenance.read(f.ledger)).total;
 for(const args of [{op:'eval'},{op:'play',url:'https://example.test/a.wav'},{op:'seek',seconds:NaN},{op:'load',audio_id:'../../outside'},{op:'play',seconds:2}])await assert.rejects(f.service.command({session_id:f.session_id,...args}),{status:400});
 await assert.rejects(f.service.heartbeat({session_id:f.session_id,applied_revision:0,status:{phase:'playing',time:0,duration:8,script:'x'}}),{status:400});
 await assert.rejects(f.service.heartbeat({session_id:f.session_id,applied_revision:0,status:{phase:'error',time:0,duration:null,error:'x'.repeat(301)}}),{status:400});
 assert.equal((await provenance.read(f.ledger)).total,before);
 assert.equal((await f.service.sessions()).sessions[0].revision,0);
});

test('heartbeats refresh reported time and expiry without logging unchanged status every second',async t=>{
 const f=await setup(t);await f.service.register(f.registration);const audio=await f.upload();await f.command('load',{audio_id:audio.audio_id});
 const heartbeat=(time,phase='playing',error='')=>f.service.heartbeat({session_id:f.session_id,applied_revision:1,status:{phase,time,duration:8,error}},'user');
 const first=await heartbeat(0);const count=(await provenance.read(f.ledger)).total;
 for(let i=1;i<=5;i++){f.tick(1000);await heartbeat(i);}
 assert.equal((await provenance.read(f.ledger)).total,count);
 const current=(await f.service.sessions()).sessions[0];assert.equal(current.status.time,5);assert.ok(current.expiresAt>first.expiresAt);
 await heartbeat(5,'blocked','Press Play');assert.equal((await provenance.read(f.ledger)).total,count+1);
 await heartbeat(5,'blocked','Press Play');assert.equal((await provenance.read(f.ledger)).total,count+1);
 await heartbeat(5,'blocked','Browser needs Play');assert.equal((await provenance.read(f.ledger)).total,count+2);
});

async function httpSetup(t){
 const directory=await mkdtemp(path.join(os.tmpdir(),'avatar-playback-http-')),ledger={dir:path.join(directory,'ledger')};
 const routes=createAvatarRoutes({directory,json:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));},provenance:{actorFrom:provenance.actorFrom,append:(_scope,event)=>provenance.append(ledger,event)}});
 const server=http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost')).then(handled=>{if(!handled){res.writeHead(404);res.end();}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`,post=async(body,headers={},route='/api/avatars/playback')=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','x-aiplay-actor':'agent:playback-http',...headers},body:JSON.stringify(body)});const result=await response.json();if(response.status!==200)throw Object.assign(new Error(result.error),{status:response.status});return result;};
 const doc=glbDoc({skinned:true});doc.materials=[{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1]}}];doc.meshes[0].primitives[0].material=0;
 const row=await post({action:'import',data_base64:packGlb(doc).toString('base64'),name:'Fixture',source:'Test fixture',license:'Test',skeleton_family:'fixture',facing:'+Z'},{},'/api/avatars');
 return {base,post,row,ledger};
}

test('real guarded HTTP routes and MCP control playback with byte ranges and valid provenance',async t=>{
 const f=await httpSetup(t),calls=[];
 const tools=avatarPlaybackTools(async(method,route,body)=>{calls.push({method,route,body});return f.post(body,{},route);});
 const run=(name,args={})=>tools.find(tool=>tool.name===name).run(args),session_id=randomUUID();
 await f.post({action:'register',session_id,id:f.row.id,sha256:f.row.inspection.sha256,capabilities:{audio:true,lip_sync:true}});
 const audio=await run('avatar_audio_upload',{name:'voice.wav',data_base64:clip.toString('base64')});
 const command={session_id,command_id:randomUUID(),op:'load',audio_id:audio.audio_id};
 const loaded=await run('avatar_playback_command',command);assert.equal(loaded.desired.url,audio.url);assert.equal(loaded.desired.playing,false);
 assert.deepEqual(calls.at(-1),{method:'POST',route:'/api/avatars/playback',body:{action:'command',...command}});
 assert.equal((await run('avatar_playback_sessions')).sessions[0].revision,1);
 for(const [range,start,end] of [['bytes=2-6',2,6],['bytes=-5',clip.length-5,clip.length-1],['bytes=4-',4,clip.length-1]]){
  const response=await fetch(f.base+audio.url,{headers:{Range:range}});assert.equal(response.status,206);assert.equal(response.headers.get('Content-Range'),`bytes ${start}-${end}/${clip.length}`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),clip.subarray(start,end+1));
 }
 const head=await fetch(f.base+audio.url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('Content-Length'),String(clip.length));assert.equal((await head.arrayBuffer()).byteLength,0);
 for(const range of ['bytes=999-','bytes=8-2','bytes=0-1,4-5','bytes=-0'])assert.equal((await fetch(f.base+audio.url,{headers:{Range:range}})).status,416);
 assert.equal((await fetch(f.base+audio.url,{headers:{Origin:'https://evil.test'}})).status,403);
 await assert.rejects(f.post({action:'sessions'},{Origin:'https://evil.test'}),{status:403});
 const hostStatus=await new Promise((resolve,reject)=>http.get(f.base+audio.url,{headers:{Host:'evil.test'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject));assert.equal(hostStatus,403);
 const events=(await provenance.read(f.ledger)).events;assert.ok(events.some(event=>event.type==='preset_apply'&&event.data.op==='playback_command'&&event.actor==='agent:playback-http'));assert.equal((await provenance.verify(f.ledger)).ok,true);
});
