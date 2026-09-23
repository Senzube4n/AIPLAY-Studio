/** Expiring, loopback-only preview sessions and pinned local audio playback intent. */
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

export const PLAYBACK_LIMITS = Object.freeze({audioBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, audioFiles: 64, sessions: 32, sessionMs: 30000, audioMs: 24 * 60 * 60 * 1000});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const audioPattern = /^au_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const mime = {'.wav':'audio/wav','.mp3':'audio/mpeg','.ogg':'audio/ogg','.oga':'audio/ogg','.opus':'audio/ogg','.flac':'audio/flac','.m4a':'audio/mp4','.aac':'audio/aac','.webm':'audio/webm'};
const queues = new Map();
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value,allowed,label) { if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail(`Invalid ${label} fields.`); }
function sid(value) { if(typeof value!=='string'||!uuid.test(value))throw fail('Session id must be a UUID.');return value; }
function aid(value) { if(typeof value!=='string'||!audioPattern.test(value))throw fail('Invalid local audio id.');return value; }
function sourceIdentity(input) { if(typeof input.id!=='string'||!/^av_[a-f0-9-]{36}$/.test(input.id)||typeof input.sha256!=='string'||!hashPattern.test(input.sha256))throw fail('Avatar id and source hash are required.'); }
function number(value,label,max=86400) { if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max)throw fail(`Invalid ${label}.`);return value; }
function revision(value) { if(!Number.isSafeInteger(value)||value<0)throw fail('Invalid applied revision.');return value; }
async function serial(key,work) { const prior=queues.get(key)||Promise.resolve(),next=prior.catch(()=>{}).then(work);queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);} }
async function atomic(file,value) { const temp=`${file}.${randomUUID()}.tmp`;try{await writeFile(temp,JSON.stringify(value),{flag:'wx'});await rename(temp,file);}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});} }

export function createAvatarPlayback({directory,inspectAsset,record=async()=>{},now=Date.now}) {
  if(typeof inspectAsset!=='function')throw new TypeError('inspectAsset is required.');
  const sessionsDir=path.join(directory,'sessions'),audioDir=path.join(directory,'audio'),lock=path.resolve(directory);
  const sessionPath=id=>path.join(sessionsDir,`${sid(id)}.json`),audioPath=id=>path.join(audioDir,`${aid(id)}.json`),binaryPath=id=>path.join(audioDir,`${aid(id)}.bin`);
  async function prepare(){await Promise.all([mkdir(sessionsDir,{recursive:true}),mkdir(audioDir,{recursive:true})]);}
  async function read(file,label){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')throw fail(`${label} not found.`,404);throw error;}}
  async function source(input){sourceIdentity(input);const {row,bytes}=await inspectAsset(input.id);if(row?.id!==input.id||row.inspection?.sha256!==input.sha256||digest(bytes)!==input.sha256)throw fail('Avatar source changed; reload the preview.',409);}
  async function session(id){const row=await read(sessionPath(id),'Preview session');if(row.session_id!==id)throw fail('Session identity mismatch.',409);if(row.expiresAt<=now())throw fail('Preview session expired; open or refresh its browser window.',410);return row;}
  async function audio(id){const row=await read(audioPath(id),'Audio');if(row.audio_id!==id)throw fail('Audio identity mismatch.',409);if(row.expiresAt<=now())throw fail('Local audio expired; choose the file again.',410);return row;}
  const publicSession=row=>{const {commands,...result}=row;return structuredClone(result);};
  async function event(op,actor,asset,data){await record({type:op==='audio_upload'?'import':op==='playback_command'?'preset_apply':'edit',actor,asset,data:{op,...data}});}
  async function entries(dir,pattern){let names;try{names=await readdir(dir);}catch(error){if(error.code==='ENOENT')return [];throw error;}return names.filter(name=>name.endsWith('.json')&&pattern.test(name.slice(0,-5)));}
  async function cleanup(actor){
    await prepare();
    for(const [dir,pattern,kind] of [[sessionsDir,uuid,'session'],[audioDir,audioPattern,'audio']])for(const name of await entries(dir,pattern)){
      const file=path.join(dir,name),row=await read(file,kind);
      if(row.expiresAt>now())continue;
      const id=name.slice(0,-5);await event('playback_expire',actor,`avatar_playback/${kind}/${id}`,{kind,id});
      await unlink(file);if(kind==='audio')await unlink(binaryPath(id)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
  }
  function status(value){
    fields(value,['phase','time','duration','error'],'playback status');
    if(!['empty','ready','loading','playing','paused','ended','blocked','error'].includes(value.phase))throw fail('Invalid playback phase.');
    number(value.time,'playback time');if(value.duration!==null)number(value.duration,'audio duration');
    if(value.error!==undefined&&(typeof value.error!=='string'||value.error.length>300))throw fail('Playback error is too long.');
    return {phase:value.phase,time:value.time,duration:value.duration,...(value.error===undefined?{}:{error:value.error})};
  }
  async function register(input,actor='system'){
    fields(input,['session_id','id','sha256','capabilities'],'registration');const request=structuredClone(input);sid(request.session_id);sourceIdentity(request);
    fields(request.capabilities,['audio','lip_sync'],'capabilities');if(typeof request.capabilities.audio!=='boolean'||typeof request.capabilities.lip_sync!=='boolean'||request.capabilities.lip_sync&&!request.capabilities.audio)throw fail('Invalid preview capabilities.');
    return serial(lock,async()=>{
      await source(request);await cleanup(actor);
      let previous;try{previous=await session(request.session_id);}catch(error){if(error.status!==404&&error.status!==410)throw error;}
      if(previous&&(previous.id!==request.id||previous.sha256!==request.sha256))throw fail('Session belongs to another avatar; use a new session id.',409);
      if(!previous&&(await entries(sessionsDir,uuid)).length>=PLAYBACK_LIMITS.sessions)throw fail('Too many active preview sessions.',409);
      const row=previous||{session_id:request.session_id,id:request.id,sha256:request.sha256,revision:0,applied_revision:0,
        desired:{audio_id:null,url:null,name:null,bytes:0,playing:false,time:0,load_revision:0,seek_revision:0},status:{phase:'empty',time:0,duration:null},commands:[]};
      row.capabilities=request.capabilities;row.expiresAt=now()+PLAYBACK_LIMITS.sessionMs;
      await event('playback_register',actor,`avatar/${row.id}/playback/${row.session_id}`,{session_id:row.session_id,avatarId:row.id,sha256:row.sha256,capabilities:row.capabilities});
      await atomic(sessionPath(row.session_id),row);return publicSession(row);
    });
  }
  async function heartbeat(input,actor='system'){
    fields(input,['session_id','applied_revision','status'],'heartbeat');const request=structuredClone(input);sid(request.session_id);revision(request.applied_revision);const reported=status(request.status);
    return serial(lock,async()=>{const row=await session(request.session_id);if(request.applied_revision<row.applied_revision||request.applied_revision>row.revision)throw fail('Applied revision is stale or ahead of playback state.',409);
      const changed=row.applied_revision!==request.applied_revision||row.status.phase!==reported.phase||(row.status.error||'')!==(reported.error||'');
      row.applied_revision=request.applied_revision;row.status=reported;row.expiresAt=now()+PLAYBACK_LIMITS.sessionMs;
      if(changed)await event('playback_heartbeat',actor,`avatar/${row.id}/playback/${row.session_id}`,{session_id:row.session_id,avatarId:row.id,applied_revision:row.applied_revision,status:reported});
      await atomic(sessionPath(row.session_id),row);return publicSession(row);});
  }
  async function sessions(){
    await prepare();const result=[];
    for(const name of await entries(sessionsDir,uuid)){try{result.push(publicSession(await session(name.slice(0,-5))));}catch(error){if(error.status!==410&&error.status!==404)throw error;}}
    return {sessions:result.sort((a,b)=>a.session_id.localeCompare(b.session_id))};
  }
  async function upload(input,actor='system'){
    fields(input,['name','data_base64'],'audio upload');const request=structuredClone(input);
    if(typeof request.name!=='string'||!request.name.trim()||request.name.length>160||/[\\/\u0000-\u001f]/.test(request.name)||!mime[path.extname(request.name).toLowerCase()])throw fail('Use an audio filename with a supported extension.');
    const data=request.data_base64;if(typeof data!=='string'||!data.length||data.length>Math.ceil(PLAYBACK_LIMITS.audioBytes/3)*4||data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw fail('Invalid audio upload.',413);
    const bytes=Buffer.from(data,'base64');if(!bytes.length||bytes.length>PLAYBACK_LIMITS.audioBytes||bytes.toString('base64')!==data)throw fail('Invalid audio bytes.',413);
    return serial(lock,async()=>{
      await cleanup(actor);const existing=await Promise.all((await entries(audioDir,audioPattern)).map(name=>read(path.join(audioDir,name),'Audio')));
      if(existing.length>=PLAYBACK_LIMITS.audioFiles||existing.reduce((sum,row)=>sum+row.bytes,0)+bytes.length>PLAYBACK_LIMITS.totalBytes)throw fail('Local audio storage is full; expired audio is removed after 24 hours.',409);
      const audio_id=`au_${randomUUID()}`,row={audio_id,name:request.name,bytes:bytes.length,sha256:digest(bytes),url:`/api/avatars/playback/audio/${audio_id}`,mime:mime[path.extname(request.name).toLowerCase()],expiresAt:now()+PLAYBACK_LIMITS.audioMs};
      await event('audio_upload',actor,`avatar_playback/audio/${audio_id}`,{audio_id,name:row.name,bytes:row.bytes,sha256:row.sha256});
      await writeFile(binaryPath(audio_id),bytes,{flag:'wx'});
      try{await atomic(audioPath(audio_id),row);}catch(error){await unlink(binaryPath(audio_id)).catch(()=>{});throw error;}
      return structuredClone(row);
    });
  }
  async function command(input,actor='system'){
    fields(input,['session_id','command_id','op','audio_id','seconds'],'playback command');const request=structuredClone(input);sid(request.session_id);if(request.command_id!==undefined)sid(request.command_id);
    if(!['load','play','pause','stop','seek'].includes(request.op))throw fail('Unknown playback command.');
    if(request.op==='load')aid(request.audio_id);else if(request.audio_id!==undefined)throw fail('Only load accepts an audio id.');
    if(request.op==='seek')number(request.seconds,'seek time');else if(request.seconds!==undefined)throw fail('Only seek accepts seconds.');
    const identity=digest(Buffer.from(JSON.stringify({op:request.op,audio_id:request.audio_id,seconds:request.seconds})));
    return serial(lock,async()=>{
      const row=await session(request.session_id);await source(row);
      const previous=request.command_id&&row.commands.find(entry=>entry.id===request.command_id);
      if(previous){if(previous.identity!==identity)throw fail('Command id was already used with different arguments.',409);return publicSession(row);}
      if(request.command_id&&row.commands.length>=4096)throw fail('Session command history is full; register a new preview session.',409);
      if(!row.capabilities.audio)throw fail('This preview cannot play audio.',409);
      const next=row.revision+1;if(!Number.isSafeInteger(next))throw fail('Playback revision exhausted.',409);
      if(request.op==='load'){
        const clip=await audio(request.audio_id);row.desired={audio_id:clip.audio_id,url:clip.url,name:clip.name,bytes:clip.bytes,playing:false,time:0,load_revision:next,seek_revision:next};
      }else{
        if(!row.desired.audio_id)throw fail('Load local audio before controlling playback.',409);
        await audio(row.desired.audio_id);
        if(request.op==='play')row.desired.playing=true;
        if(request.op==='pause'||request.op==='stop')row.desired.playing=false;
        if(request.op==='seek'||request.op==='stop'){row.desired.time=request.op==='seek'?request.seconds:0;row.desired.seek_revision=next;}
      }
      row.revision=next;
      if(request.command_id)row.commands.push({id:request.command_id,identity});
      await event('playback_command',actor,`avatar/${row.id}/playback/${row.session_id}`,{op:'playback_command',command:request.op,command_id:request.command_id||null,session_id:row.session_id,avatarId:row.id,revision:next,audio_id:row.desired.audio_id,...(request.seconds===undefined?{}:{seconds:request.seconds})});
      await atomic(sessionPath(row.session_id),row);return publicSession(row);
    });
  }
  async function media(id){const row=await audio(id),file=binaryPath(id),info=await stat(file);if(!info.isFile()||info.size!==row.bytes||digest(await readFile(file))!==row.sha256)throw fail('Local audio changed; upload it again.',409);return {row,file};}
  return {register,heartbeat,sessions,upload,command,media};
}

/** Mounted only after avatar.js's same-origin loopback guard has succeeded. */
export function createAvatarPlaybackRoutes({directory,inspectAsset,json,provenance}){
  const service=createAvatarPlayback({directory,inspectAsset,record:event=>provenance.append('library',event)});
  return async(req,res,url)=>{
    const audio=url.pathname.match(/^\/api\/avatars\/playback\/audio\/(au_[a-f0-9-]{36})$/);
    if(audio&&(req.method==='GET'||req.method==='HEAD')){
      const {row,file}=await service.media(audio[1]);let start=0,end=row.bytes-1,status=200;
      if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${row.bytes}`});res.end();return true;}
        if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,row.bytes-suffix);if(!suffix)start=row.bytes;}
        else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=row.bytes){res.writeHead(416,{'Content-Range':`bytes */${row.bytes}`});res.end();return true;}status=206;
      }
      res.writeHead(status,{'Content-Type':row.mime,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Content-Disposition':'inline',...(status===206?{'Content-Range':`bytes ${start}-${end}/${row.bytes}`}:{})});
      if(req.method==='HEAD'){res.end();return true;}
      const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
    }
    if(url.pathname!=='/api/avatars/playback')return false;
    if(req.method!=='POST')throw fail('Use POST for playback controls.',405);
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw fail('Playback controls require application/json.',415);
    const limit=Math.ceil(PLAYBACK_LIMITS.audioBytes/3)*4+2048,chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>limit)throw fail('Audio request exceeds 32 MiB.',413);chunks.push(chunk);}
    let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('Invalid playback JSON.');}
    if(!object(input))throw fail('Playback request must be an object.');
    const {action,...args}=input,actor=provenance.actorFrom(req);let result;
    if(action==='register')result=await service.register(args,actor);
    else if(action==='heartbeat')result=await service.heartbeat(args,actor);
    else if(action==='sessions'){fields(args,[],'sessions');result=await service.sessions();}
    else if(action==='upload')result=await service.upload(args,actor);
    else if(action==='command')result=await service.command(args,actor);
    else throw fail('Unknown playback action.');
    json(res,200,result);return true;
  };
}
