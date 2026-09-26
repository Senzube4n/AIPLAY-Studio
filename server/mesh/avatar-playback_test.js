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
async function setup(t,{vrm=false}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'avatar-playback-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const doc=glbDoc({skinned:true});
 doc.extensions={VRMC_vrm:{expressions:{preset:{aa:{morphTargetBinds:[{node:0,index:0,weight:1}]},happy:{morphTargetBinds:[{node:0,index:1,weight:1}]},blink:{morphTargetBinds:[]}},custom:{sharedMouth:{morphTargetBinds:[{node:0,index:0,weight:1}]},blocksMouth:{overrideMouth:'block',morphTargetBinds:[]}}}}};
 let clock=100000,bytes=vrm?packGlb(doc):Buffer.from('exact source avatar');const ledger={dir:path.join(directory,'ledger')};
 const options={directory,now:()=>clock,inspectAsset:async id=>({row:{id,inspection:{sha256:sha(bytes),profile:vrm?'vrm':'world',clips:[{index:0,name:'Dance',duration:4}],jointNames:[{index:1,name:'root'},{index:2,name:'spine'}]}},bytes}),record:event=>provenance.append(ledger,event)};
 const service=createAvatarPlayback(options),session_id=randomUUID();
 const registration={session_id,id:avatarId,sha256:sha(bytes),capabilities:{audio:true,lip_sync:true}};
 const upload=()=>service.upload({name:'voice.wav',data_base64:clip.toString('base64')},'agent:test');
 const command=(op,args={})=>service.command({session_id,command_id:randomUUID(),op,...args},'agent:test');
 return {directory,ledger,service,options,registration,session_id,upload,command,tick:value=>{clock+=value;},change:()=>{bytes=Buffer.from('new avatar');}};
}

test('VRM cues are inventory validated, bounded, retry safe, transient and independent of audio',async t=>{
 const f=await setup(t,{vrm:true});
 await f.service.register({...f.registration,capabilities:{audio:false,lip_sync:false}});
 const inventory=await f.service.cueInventory({id:avatarId,sha256:f.registration.sha256});
 assert.deepEqual(inventory.expressions.map(item=>item.name),['happy','blink']);
 for(const expression of ['aa','sharedMouth','blocksMouth','invented'])await assert.rejects(f.command('cue',{expression,duration_ms:3000}),{status:422});
 for(const duration_ms of [0,249,10001,1.5])await assert.rejects(f.command('cue',{expression:'happy',duration_ms}),{status:400});
 const command_id=randomUUID(),request={session_id:f.session_id,command_id,op:'cue',expression:'happy',duration_ms:3000};
 const first=await f.service.command(request);assert.equal(first.revision,1);
 assert.equal(first.desired.cue.durationMs,3000);assert.equal(first.desired.cue.expiresAt,null);
 assert.equal(first.desired.audio_revision,0);
 assert.deepEqual(await f.service.command(request),first);
 await assert.rejects(f.service.command({...request,duration_ms:4000}),{status:409});
 f.tick(3001);
 assert.equal((await f.service.sessions()).sessions[0].desired.cue.revision,1,'an unobserved cue remains pending');
 const seen=await f.service.heartbeat({session_id:f.session_id,applied_revision:1,status:{phase:'empty',time:0,duration:null}});
 assert.equal(seen.desired.cue.expiresAt,106001);
 f.tick(3001);
 assert.equal((await f.service.sessions()).sessions[0].desired.cue,null);
 assert.equal((await f.service.command(request)).desired.cue,null,'retry must not resurrect an expired cue');
 const next=await f.command('cue',{expression:'blink',duration_ms:250});assert.equal(next.revision,2);
 const cleared=await f.command('clear_cue');assert.equal(cleared.desired.cue,null);
 assert.equal(cleared.desired.audio_id,null);assert.equal(cleared.revision,3);
 await assert.rejects(f.service.cueInventory({id:avatarId,sha256:'0'.repeat(64)}),{status:409});
 assert.equal((await provenance.verify(f.ledger)).ok,true);
});

test('a 250 ms cue survives the browser polling interval and expires after acknowledgment',async t=>{
 const f=await setup(t,{vrm:true});await f.service.register(f.registration);
 await f.command('cue',{expression:'happy',duration_ms:250});
 f.tick(1000);
 const pending=(await f.service.sessions()).sessions[0];
 assert.equal(pending.desired.cue.expression,'happy');
 assert.equal(pending.desired.cue.expiresAt,null);
 const seen=await f.service.heartbeat({session_id:f.session_id,applied_revision:1,status:{phase:'empty',time:0,duration:null}});
 assert.equal(seen.desired.cue.expiresAt,101250);
 f.tick(251);
 assert.equal((await f.service.sessions()).sessions[0].desired.cue,null);
});

test('generic GLB and arbitrary cue fields cannot enter preview state',async t=>{
 const f=await setup(t);await f.service.register(f.registration);
 await assert.rejects(f.service.cueInventory({id:avatarId,sha256:f.registration.sha256}),{status:422});
 await assert.rejects(f.command('cue',{expression:'happy',duration_ms:3000}),{status:422});
 await assert.rejects(f.command('clear_cue',{expression:'happy'}),{status:400});
 assert.equal((await f.service.sessions()).sessions[0].revision,0);
});

test('loading audio during an active expression cue preserves both intents',async t=>{
 const f=await setup(t,{vrm:true});await f.service.register(f.registration);
 const cued=await f.command('cue',{expression:'happy',duration_ms:3000});
 const audio=await f.upload(),loaded=await f.command('load',{audio_id:audio.audio_id});
 assert.deepEqual(loaded.desired.cue,cued.desired.cue);
 assert.equal(loaded.desired.audio_id,audio.audio_id);
 const playing=await f.command('play');assert.equal(playing.desired.playing,true);assert.deepEqual(playing.desired.cue,cued.desired.cue);
});

test('embedded motion commands are clip-bound, independent of audio and acknowledged by the preview',async t=>{
 const f=await setup(t);await f.service.register({...f.registration,capabilities:{audio:false,lip_sync:false,motion:true}});
 const selected=await f.command('motion_select',{clip_index:0});
 assert.deepEqual(selected.desired.motion,{clip_index:0,playing:false,time:0,speed:1,time_revision:1});
 assert.equal(selected.desired.audio_revision,0);assert.equal(selected.applied_revision,0);
 const playing=await f.command('motion_play');assert.equal(playing.desired.motion.playing,true);
 const sped=await f.command('motion_speed',{speed:0.75});assert.equal(sped.desired.motion.speed,0.75);
 assert.equal(sped.desired.motion.time_revision,1,'speed does not restart the clip');
 const seeked=await f.command('motion_seek',{seconds:2.5});assert.equal(seeked.desired.motion.time,2.5);
 assert.equal(seeked.desired.motion.playing,false);assert.equal(seeked.desired.motion.time_revision,4);
 const seen=await f.service.heartbeat({session_id:f.session_id,applied_revision:4,status:{phase:'empty',time:0,duration:null}});
 assert.equal(seen.applied_revision,4);
 const paused=await f.command('motion_pause');assert.equal(paused.desired.motion.playing,false);
 const stopped=await f.command('motion_stop');assert.equal(stopped.desired.motion.time,0);
 assert.equal(stopped.desired.motion.time_revision,6);
 const rest=await f.command('motion_select',{clip_index:null});assert.equal(rest.desired.motion.clip_index,null);
 await assert.rejects(f.command('motion_play'),{status:409});
 await assert.rejects(f.command('motion_select',{clip_index:1}),{status:422});
 await assert.rejects(f.command('motion_select',{clip_index:-1}),{status:400});
 await assert.rejects(f.command('motion_speed',{speed:2.1}),{status:400});
 await f.command('motion_select',{clip_index:0});
 await assert.rejects(f.command('motion_seek',{seconds:4.1}),{status:422});
 await assert.rejects(f.command('motion_play',{audio_id:'au_12345678-1234-1234-1234-123456789abc'}),{status:400});
 const request={session_id:f.session_id,command_id:randomUUID(),op:'motion_speed',speed:1.5};
 const once=await f.service.command(request),twice=await f.service.command(request);
 assert.deepEqual(once,twice);await assert.rejects(f.service.command({...request,speed:1}),{status:409});
 assert.equal((await provenance.verify(f.ledger)).ok,true);
});

test('motion requires an advertised capable session and refuses a changed avatar source',async t=>{
 const f=await setup(t);await f.service.register(f.registration);
 await assert.rejects(f.command('motion_select',{clip_index:0}),{status:409});
 await assert.rejects(f.service.register({...f.registration,capabilities:{audio:true,lip_sync:true,motion:'yes'}}),{status:400});
 await f.service.register({...f.registration,capabilities:{audio:true,lip_sync:true,motion:true}});
 f.change();await assert.rejects(f.command('motion_select',{clip_index:0}),{status:409});
});

test('Workshop VRM movement test is MCP controlled, exclusive with clips, and acknowledged by the browser',async t=>{
 const f=await setup(t,{vrm:true});
 await f.service.register({...f.registration,capabilities:{audio:true,lip_sync:false,motion:true,preview_motion:true}});
 const clip=await f.command('motion_select',{clip_index:0});assert.equal(clip.desired.motion.clip_index,0);
 const command_id=randomUUID(),request={session_id:f.session_id,command_id,op:'preview_motion_start'};
 const started=await f.service.command(request);
 assert.equal(started.desired.preview_motion,true);assert.equal(started.desired.preview_motion_revision,2);
 assert.equal(started.desired.motion.clip_index,null);assert.equal(started.desired.motion_revision,2);
 assert.equal(started.desired.audio_revision,0);assert.equal(started.applied_revision,0);
 assert.deepEqual(await f.service.command(request),started,'a retried start is idempotent');
 await assert.rejects(f.service.command({...request,op:'preview_motion_stop'}),{status:409});
 const seen=await f.service.heartbeat({session_id:f.session_id,applied_revision:2,status:{phase:'empty',time:0,duration:null}});
 assert.equal(seen.applied_revision,2);
 const stopped=await f.command('preview_motion_stop');assert.equal(stopped.desired.preview_motion,false);
 await f.command('preview_motion_start');
 const selected=await f.command('motion_select',{clip_index:0});
 assert.equal(selected.desired.preview_motion,false);assert.equal(selected.desired.preview_motion_revision,5);
 assert.equal(selected.desired.motion.clip_index,0);
 await f.command('preview_motion_start');
 const audio=await f.upload(),loaded=await f.command('load',{audio_id:audio.audio_id});
 assert.equal(loaded.desired.preview_motion,true,'loading voice does not stop the movement test');
 assert.equal(loaded.desired.audio_id,audio.audio_id);
 assert.equal((await provenance.verify(f.ledger)).ok,true);
});

test('VRM movement test refuses generic assets, incapable sessions and extra fields',async t=>{
 const generic=await setup(t);await generic.service.register({...generic.registration,capabilities:{audio:true,lip_sync:false,preview_motion:true}});
 await assert.rejects(generic.command('preview_motion_start'),{status:409});
 const vrm=await setup(t,{vrm:true});await vrm.service.register(vrm.registration);
 await assert.rejects(vrm.command('preview_motion_start'),{status:409});
 await assert.rejects(vrm.service.register({...vrm.registration,capabilities:{audio:true,lip_sync:true,preview_motion:'yes'}}),{status:400});
 await vrm.service.register({...vrm.registration,capabilities:{audio:true,lip_sync:true,preview_motion:true}});
 await assert.rejects(vrm.command('preview_motion_start',{seconds:1}),{status:400});
 vrm.change();await assert.rejects(vrm.command('preview_motion_start'),{status:409});
});

test('joint bend is hash and inventory bound, preview acknowledged, and exclusive with clips',async t=>{
 const f=await setup(t);await f.service.register({...f.registration,capabilities:{audio:true,lip_sync:false,motion:true,joint_pose:true}});
 await assert.rejects(f.command('joint_pose',{node_index:99,axis:'z',degrees:20}),{status:422});
 for(const bend of [{node_index:2,axis:'q',degrees:20},{node_index:2,axis:'z',degrees:46},{node_index:2,axis:'z',degrees:NaN}])
   await assert.rejects(f.command('joint_pose',bend),{status:400});
 const clip=await f.command('motion_select',{clip_index:0});assert.equal(clip.desired.motion.clip_index,0);
 const posed=await f.command('joint_pose',{node_index:2,axis:'z',degrees:30});
 assert.deepEqual(posed.desired.joint_pose,{node_index:2,axis:'z',degrees:30});
 assert.equal(posed.desired.joint_pose_revision,2);assert.equal(posed.desired.motion.clip_index,null);
 assert.equal(posed.desired.audio_revision,0);
 await assert.rejects(f.command('motion_play'),{status:409});
 const seen=await f.service.heartbeat({session_id:f.session_id,applied_revision:2,status:{phase:'empty',time:0,duration:null}});
 assert.equal(seen.applied_revision,2);
 const audio=await f.upload(),loaded=await f.command('load',{audio_id:audio.audio_id});
 assert.deepEqual(loaded.desired.joint_pose,posed.desired.joint_pose);
 const motion=await f.command('motion_select',{clip_index:0});
 assert.equal(motion.desired.joint_pose,null);assert.equal(motion.desired.joint_pose_revision,4);
 const reset=await f.command('joint_reset');assert.equal(reset.desired.motion.clip_index,0,'reset does not stop an unrelated clip');
 const request={session_id:f.session_id,command_id:randomUUID(),op:'joint_pose',node_index:2,axis:'x',degrees:-15};
 const once=await f.service.command(request),twice=await f.service.command(request);assert.deepEqual(once,twice);
 await assert.rejects(f.service.command({...request,degrees:-14}),{status:409});
 f.change();await assert.rejects(f.command('joint_pose',{node_index:2,axis:'x',degrees:10}),{status:409});
 assert.equal((await provenance.verify(f.ledger)).ok,true);
});

test('joint controls need a capable preview and migration restores older sessions',async t=>{
 const f=await setup(t);await f.service.register(f.registration);
 await assert.rejects(f.command('joint_pose',{node_index:2,axis:'z',degrees:10}),{status:409});
 await assert.rejects(f.service.register({...f.registration,capabilities:{audio:true,lip_sync:true,joint_pose:'yes'}}),{status:400});
 const file=path.join(f.directory,'sessions',`${f.session_id}.json`),old=JSON.parse(await readFile(file,'utf8'));
 delete old.desired.joint_pose;delete old.desired.joint_pose_revision;
 delete old.desired.preview_motion;delete old.desired.preview_motion_revision;await writeFile(file,JSON.stringify(old));
 const resumed=await f.service.register({...f.registration,capabilities:{audio:true,lip_sync:true,joint_pose:true}});
 assert.equal(resumed.desired.joint_pose,null);assert.equal(resumed.desired.joint_pose_revision,0);
 assert.equal(resumed.desired.preview_motion,false);assert.equal(resumed.desired.preview_motion_revision,0);
});

test('a session saved before motion support keeps its audio intent when the browser registers again',async t=>{
 const f=await setup(t);await f.service.register(f.registration);
 const audio=await f.upload();await f.command('load',{audio_id:audio.audio_id});
 const file=path.join(f.directory,'sessions',`${f.session_id}.json`),old=JSON.parse(await readFile(file,'utf8'));
 delete old.desired.motion;delete old.desired.motion_revision;
 await writeFile(file,JSON.stringify(old));
 const resumed=await f.service.register({...f.registration,capabilities:{audio:true,lip_sync:true,motion:true}});
 assert.equal(resumed.desired.audio_id,audio.audio_id);
 assert.equal(resumed.desired.load_revision,1);
 assert.deepEqual(resumed.desired.motion,{clip_index:null,playing:false,time:0,speed:1,time_revision:0});
 assert.equal(resumed.desired.motion_revision,0);
 await f.command('motion_select',{clip_index:0});
 assert.equal((await f.service.sessions()).sessions[0].desired.audio_id,audio.audio_id);
});

test('loading audio keeps selected motion and its revision',async t=>{
 const f=await setup(t);await f.service.register({...f.registration,capabilities:{audio:true,lip_sync:true,motion:true}});
 const motion=await f.command('motion_select',{clip_index:0});
 const audio=await f.upload();const loaded=await f.command('load',{audio_id:audio.audio_id});
 assert.deepEqual(loaded.desired.motion,motion.desired.motion);
 assert.equal(loaded.desired.motion_revision,1);
 assert.equal(loaded.desired.audio_revision,2);
});

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
 assert.ok(tools.find(tool=>tool.name==='avatar_playback_command').inputSchema.properties.op.enum.includes('preview_motion_start'));
 const run=(name,args={})=>tools.find(tool=>tool.name===name).run(args),session_id=randomUUID();
 await f.post({action:'register',session_id,id:f.row.id,sha256:f.row.inspection.sha256,capabilities:{audio:true,lip_sync:true,joint_pose:true}});
 const audio=await run('avatar_audio_upload',{name:'voice.wav',data_base64:clip.toString('base64')});
 const command={session_id,command_id:randomUUID(),op:'load',audio_id:audio.audio_id};
 const loaded=await run('avatar_playback_command',command);assert.equal(loaded.desired.url,audio.url);assert.equal(loaded.desired.playing,false);
 assert.deepEqual(calls.at(-1),{method:'POST',route:'/api/avatars/playback',body:{action:'command',...command}});
 await assert.rejects(run('avatar_cue_inventory',{id:f.row.id,sha256:f.row.inspection.sha256}),{status:422});
 assert.deepEqual(calls.at(-1),{method:'POST',route:'/api/avatars/playback',body:{action:'cue_inventory',id:f.row.id,sha256:f.row.inspection.sha256}});
 const cueCommand={session_id,command_id:randomUUID(),op:'cue',expression:'happy',duration_ms:3000};
 await assert.rejects(run('avatar_playback_command',cueCommand),{status:422});
 assert.deepEqual(calls.at(-1),{method:'POST',route:'/api/avatars/playback',body:{action:'command',...cueCommand}});
 const motionCommand={session_id,command_id:randomUUID(),op:'motion_select',clip_index:0};
 await assert.rejects(run('avatar_playback_command',motionCommand),{status:409});
 assert.deepEqual(calls.at(-1),{method:'POST',route:'/api/avatars/playback',body:{action:'command',...motionCommand}});
 const previewCommand={session_id,command_id:randomUUID(),op:'preview_motion_start'};
 await assert.rejects(run('avatar_playback_command',previewCommand),{status:409});
 assert.deepEqual(calls.at(-1),{method:'POST',route:'/api/avatars/playback',body:{action:'command',...previewCommand}});
 const jointCommand={session_id,command_id:randomUUID(),op:'joint_pose',node_index:f.row.inspection.jointNames[1].index,axis:'z',degrees:20};
 assert.deepEqual((await run('avatar_playback_command',jointCommand)).desired.joint_pose,{node_index:jointCommand.node_index,axis:'z',degrees:20});
 assert.deepEqual(calls.at(-1),{method:'POST',route:'/api/avatars/playback',body:{action:'command',...jointCommand}});
 assert.equal((await run('avatar_playback_sessions')).sessions[0].revision,2);
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
