/** Local, hash-pinned attachment binding jobs. Never mutates or installs an avatar. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile, writeFile, mkdir, stat, rename} from 'node:fs/promises';
import {statSync} from 'node:fs';
import validator from 'gltf-validator';
import {config, weightTransferScriptPath} from '../config.js';
import {normalizeActor} from '../provenance.js';
import {readGlb, assertSkinned} from './glb.js';
import {toolkitScriptHelp} from './previz-toolkit.js';

export const WEIGHT_TRANSFER_LIMITS = Object.freeze({bytes:128*1024*1024, timeoutMs:300000, vertices:200000, joints:256});
const marker='WEIGHT_TRANSFER_RESULT_JSON:';
// weight_transfer.py imports bpy, so it is NOT in this Apache-2.0 tree (see
// server/licence_test.js): config.js weightTransferScriptPath() finds it outside
// the tree, as deform.js does for deform.py. It still imports
// unirig_adapter from this folder, which is why the spawn puts this folder on
// PYTHONPATH — the script resolves its stdlib-only helper from outside the tree.
const meshDir=path.dirname(fileURLToPath(import.meta.url));
const scriptMissing=script=>fault(`The weight-transfer script is not at ${script}. It imports bpy, so this Apache-2.0 tree ships no copy of it. ${toolkitScriptHelp('weight_transfer.py',['AIPLAY_WEIGHT_TRANSFER_SCRIPT'])}`,503);
const isFileSync=file=>{try{return statSync(file).isFile();}catch{return false;}};
const jobPattern=/^wt_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hashPattern=/^[a-f0-9]{64}$/;
const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const strict=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw fault('Unsupported weight-transfer fields.');};
const pin=(value,label)=>{if(typeof value!=='string'||!hashPattern.test(value))throw fault(`${label} must be a SHA-256 returned by inspection.`);return value;};

/** Fixed executable plus argv only, one bounded process, no shell or child tree. */
export function runWeightPython(python,args,{timeoutMs=WEIGHT_TRANSFER_LIMITS.timeoutMs,spawnImpl=spawn,script=weightTransferScriptPath()}={}) {
  return new Promise((resolve,reject)=>{
    let child,timer,settled=false,stdout='',stderr='',size=0;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    // A missing script is a setup sentence, never a spawn: python would only
    // report a file-not-found that reads like a crash in this feature.
    if(!isFileSync(script)){finish(scriptMissing(script));return;}
    try {
      child=spawnImpl(python,['-u',script,...args],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],
        env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',
          PYTHONPATH:[meshDir,process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)}});
      timer=setTimeout(()=>{child.kill();finish(fault('Local weight transfer timed out; no part was admitted.',504));},timeoutMs);
      const receive=channel=>chunk=>{size+=chunk.length;if(size>1024*1024){child.kill();finish(fault('Weight-transfer output exceeded its bounded log limit.',502));return;}if(channel==='out')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');};
      child.stdout.on('data',receive('out'));child.stderr.on('data',receive('err'));
      child.once('error',e=>finish(fault(`Cannot run local Blender Python. Set AIPLAY_AVATAR_PYTHON to an interpreter with bpy. ${e.code||e.message}`,503)));
      child.once('close',code=>{
        if(settled)return;
        const lines=stdout.split(/\r?\n/).filter(s=>s.startsWith(marker));let report;
        try{if(lines.length!==1)throw new Error('missing or repeated result');report=JSON.parse(lines[0].slice(marker.length));}catch{finish(fault('Weight transfer returned no unambiguous JSON result.',502));return;}
        if(code!==0||report?.ok!==true){finish(fault(String(report?.error||stderr.slice(-1200)||`Weight transfer exited ${code}.`),422));return;}
        finish(null,report);
      });
    } catch(error){finish(fault(`Could not launch local Blender Python: ${error.message}`,503));}
  });
}

async function inputBytes(input,key){
  const file=input[`${key}_path`],bytes=input[`${key}_bytes`];
  if((file!==undefined)===(bytes!==undefined))throw fault(`Provide exactly one ${key}_path or ${key}_bytes.`);
  let result;
  if(bytes!==undefined){if(!Buffer.isBuffer(bytes))throw fault(`${key}_bytes must be a Buffer.`);result=Buffer.from(bytes);}
  else {
    if(typeof file!=='string'||file.length>4096||file.includes('\0')||!path.isAbsolute(file)||!['.glb','.vrm'].includes(path.extname(file).toLowerCase()))throw fault(`${key}_path must be an absolute local GLB/VRM path.`);
    const info=await stat(file);if(!info.isFile()||info.size>WEIGHT_TRANSFER_LIMITS.bytes)throw fault(`${key} exceeds 128 MiB or is not a regular file.`,413);
    result=await readFile(file);
  }
  if(result.length>WEIGHT_TRANSFER_LIMITS.bytes)throw fault(`${key} exceeds 128 MiB.`,413);
  const parsed=readGlb(result);if(!parsed.ok)throw fault(`${key}: ${parsed.why.join('; ')}`);
  return {bytes:result,sha256:digest(result)};
}

export function createWeightTransferService({directory,python,run=runWeightPython,record=async()=>{},validate=validateOutput,
  readJob=async file=>JSON.parse(await readFile(file,'utf8')),renameJob=rename}={}){
  directory=path.resolve(directory||path.join(config.dataDir,'avatar-weight-transfer'));
  const running=new Map();let reserved=false;
  async function interpreter(){
    const explicit=python||process.env.AIPLAY_AVATAR_PYTHON;
    const candidates=explicit?[explicit]:[config.mesh.unirigPython,config.mesh.python];
    let found=null;
    for(const candidate of candidates){if(typeof candidate!=='string'||!path.isAbsolute(candidate))continue;try{if((await stat(candidate)).isFile()){found=candidate;break;}}catch{}}
    if(!found)throw fault('Local weight transfer needs Blender Python with bpy. Set AIPLAY_AVATAR_PYTHON and restart Studio; nothing is downloaded automatically.',503);
    // The script sits outside this tree, so an interpreter alone is not
    // availability. Checked HERE, before inspect or submit snapshot a byte,
    // make a job folder or write a ledger event, so a missing script is the
    // same clean 503 as a missing interpreter: nothing on disk, no provenance.
    // runWeightPython keeps its own check as the backstop.
    const script=weightTransferScriptPath();if(!isFileSync(script))throw scriptMissing(script);
    return found;
  }
  const jobPath=id=>{if(!jobPattern.test(id||''))throw fault('Invalid weight-transfer job id.');return path.join(directory,id);};
  async function save(row){
    const file=path.join(jobPath(row.id),'job.json'),temp=file+'.tmp';await writeFile(temp,JSON.stringify(row,null,2));
    // On Windows a poll or scanner can hold the old destination briefly open.
    // Keep atomic replacement; never unlink the journal to work around a lock.
    for(let attempt=0;;attempt++){
      try{await renameJob(temp,file);return;}
      catch(error){if(attempt>=5||!['EPERM','EBUSY'].includes(error.code))throw error;
        await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));}
    }
  }
  async function inspect(input){
    strict(input,['reference_path','reference_bytes','target_path','target_bytes']);
    const py=await interpreter(),reference=await inputBytes(input,'reference');
    const target=input.target_path!==undefined||input.target_bytes!==undefined?await inputBytes(input,'target'):null;
    // Inspection snapshots are retained with unique ids, so an in-flight scan
    // cannot read a subsequently edited user file or collide with another scan.
    const id='wt_'+randomUUID(),dir=jobPath(id);await mkdir(dir,{recursive:true});
    const snapshot=path.join(dir,'reference.glb');await writeFile(snapshot,reference.bytes,{flag:'wx'});
    const result=await run(py,['--inspect-reference',snapshot],{timeoutMs:60000});
    if(result.mode!=='inspect-reference'||!hashPattern.test(result.skeleton||'')||!Number.isInteger(result.joints)||result.joints<2||result.joints>256
      ||!Array.isArray(result.jointNames)||result.jointNames.length!==result.joints||result.jointNames.some(n=>typeof n!=='string'||!n)||new Set(result.jointNames).size!==result.joints)
      throw fault('Invalid reference inspection result.',502);
    return {...result,reference_sha256:reference.sha256,...(target?{target_sha256:target.sha256}:{}),requiresVisualReview:true};
  }
  async function submit(input,actor='system'){
    strict(input,['reference_path','reference_bytes','target_path','target_bytes','reference_sha256','target_sha256','expected_skeleton','transform','max_distance','name','source','license']);
    if(reserved)throw fault('A weight-transfer job is already running. Poll it before submitting another.',409);
    const expected=pin(input.expected_skeleton,'expected_skeleton'),refHash=pin(input.reference_sha256,'reference_sha256'),targetHash=pin(input.target_sha256,'target_sha256');
    const transform=input.transform;
    if(!Array.isArray(transform)||transform.length!==16||transform.some(v=>typeof v!=='number'||!Number.isFinite(v))
      ||transform[3]!==0||transform[7]!==0||transform[11]!==0||transform[15]!==1)throw fault('transform must be an explicit finite affine 16-number column-major matrix.');
    if(typeof input.max_distance!=='number'||!Number.isFinite(input.max_distance)||input.max_distance<=0||input.max_distance>1)throw fault('max_distance must be in (0, 1] metres.');
    for(const [key,max] of [['name',100],['source',2000],['license',2000]])if(typeof input[key]!=='string'||!input[key].trim()||input[key].length>max)throw fault(`${key} is required (up to ${max} characters).`);
    reserved=true;
    try{
      const py=await interpreter();const reference=await inputBytes(input,'reference'),target=await inputBytes(input,'target');
      if(reference.sha256!==refHash||target.sha256!==targetHash)throw fault('Input changed since inspection; inspect the selected files again.',409);
      const id='wt_'+randomUUID(),dir=jobPath(id);await mkdir(dir,{recursive:true});
      const referenceFile=path.join(dir,'reference.glb'),targetFile=path.join(dir,'target.glb'),output=path.join(dir,'attachment.glb');
      await writeFile(referenceFile,reference.bytes,{flag:'wx'});await writeFile(targetFile,target.bytes,{flag:'wx'});
      const row={id,state:'running',actor:normalizeActor(actor),createdAt:new Date().toISOString(),name:input.name.trim(),source:input.source.trim(),license:input.license.trim(),
        reference_sha256:refHash,target_sha256:targetHash,skeleton:expected,transform:[...transform],max_distance:input.max_distance,requiresVisualReview:true};
      await record({type:'delegate',actor:row.actor,asset:`avatar-part/${id}`,data:{operation:'nearest-surface-weight-transfer',referenceSha256:refHash,targetSha256:targetHash,skeleton:expected,transform:row.transform,maxDistance:row.max_distance}});
      await save(row);
      const runningSnapshot=structuredClone(row);
      const pending=(async()=>{
        try{
          const result=await run(py,['--reference',referenceFile,'--target',targetFile,'--output',output,'--expected-skeleton',expected,
            '--transform',JSON.stringify(transform),'--max-distance',String(input.max_distance),'--mode','nearest-surface']);
          if(result.mode!=='nearest-surface'||result.skeleton!==expected||result.referenceSha256!==refHash||result.targetSha256!==targetHash||result.coverage!==1
            ||result.requiresVisualReview!==true||!Number.isInteger(result.vertices)||result.vertices<1||result.vertices>WEIGHT_TRANSFER_LIMITS.vertices
            ||!Number.isInteger(result.joints)||result.joints<2||result.joints>256||!Number.isFinite(result.maxDistance)||result.maxDistance<0||result.maxDistance>input.max_distance
            ||!Number.isFinite(result.meanDistance)||result.meanDistance<0||result.meanDistance>result.maxDistance||!Number.isFinite(result.minRetainedWeight)||result.minRetainedWeight<.9
            ||result.distanceLimit!==input.max_distance||JSON.stringify(result.transform)!==JSON.stringify(transform)||path.resolve(result.output||'')!==output)
            throw fault('Weight-transfer result does not match the pinned job.',502);
          const inspected=await validate(output);
          if(inspected.joints!==result.joints||inspected.vertices!==result.vertices)throw fault('Result geometry counts disagree with the actual GLB.',502);
          // Source snapshots are read again after execution; a subprocess cannot
          // quietly substitute either input and still receive an admitted result.
          if(digest(await readFile(referenceFile))!==refHash||digest(await readFile(targetFile))!==targetHash)throw fault('Source snapshot changed during transfer.',409);
          await record({type:'edit',actor:row.actor,asset:`avatar-part/${id}`,data:{operation:'nearest-surface-weight-transfer',referenceSha256:refHash,targetSha256:targetHash,outputSha256:inspected.sha256,skeleton:expected,source:row.source,license:row.license,visualReview:'pending'}});
          Object.assign(row,{state:'complete',completedAt:new Date().toISOString(),result:{...result,output,sha256:inspected.sha256,validation:inspected.validation}});
        }catch(error){Object.assign(row,{state:'failed',completedAt:new Date().toISOString(),error:error.message});}
        finally{try{await save(row);}finally{running.delete(id);reserved=false;}}
      })();
      running.set(id,{pending,row:runningSnapshot});
      // Save failures remain visible in status and must not become unhandled rejections.
      pending.catch(error=>{row.state='failed';row.error=`Could not persist job result: ${error.message}`;});
      return structuredClone(runningSnapshot);
    }catch(error){reserved=false;throw error;}
  }
  async function get(id){
    const file=path.join(jobPath(id),'job.json');
    // Polling an active job must not hold the journal open while Windows is
    // replacing it. This immutable running snapshot stays authoritative until
    // the final save finishes and the map entry is removed. Then the journal is
    // authoritative again; a read cannot straddle those two states.
    const active=running.get(id);
    if(active)return structuredClone(active.row);
    let row;try{row=await readJob(file);}catch(error){if(error.code==='ENOENT')throw fault('Weight-transfer job not found.',404);throw error;}
    if(row.id!==id)throw fault('Job record is inconsistent.',409);
    if(row.state==='running'&&!running.has(id))return {...row,state:'interrupted',error:'Studio restarted before this transfer completed; inspect inputs and submit a new job.'};
    if(row.state==='complete'){
      const output=path.join(jobPath(id),'attachment.glb'),checked=await validate(output);
      if(checked.sha256!==row.result?.sha256)throw fault('Transferred attachment changed on disk; the original result is no longer verified.',409);
      row.result={...row.result,output};
    }
    return row;
  }
  // interpreter() also requires the out-of-tree script, so the panel says
  // "Setup needed" when either half is absent.
  async function status(){try{return {available:true,python:await interpreter(),mode:'nearest-surface',limits:WEIGHT_TRANSFER_LIMITS,running:reserved,requiresVisualReview:true};}catch(error){return {available:false,reason:error.message,mode:'nearest-surface',limits:WEIGHT_TRANSFER_LIMITS};}}
  return {inspect,submit,get,status};
}

async function validateOutput(file){
  const info=await stat(file);if(!info.isFile()||info.size>WEIGHT_TRANSFER_LIMITS.bytes)throw fault('Transferred GLB exceeds the output limit.',422);
  const bytes=await readFile(file),glb=readGlb(bytes);if(!glb.ok)throw fault(`Invalid transferred GLB: ${glb.why.join('; ')}`,422);
  if(glb.json.buffers?.some(b=>b.uri!==undefined)||glb.json.images?.some(i=>i.uri!==undefined))throw fault('Transferred GLB must embed every resource.',422);
  const skin=assertSkinned(glb.json,glb.binData);if(!skin.ok)throw fault(`Transferred GLB has invalid weights: ${skin.why.join('; ')}`,422);
  const report=await validator.validateBytes(new Uint8Array(bytes),{maxIssues:100,externalResourceFunction:async()=>{throw new Error('External resources are not loaded.');}});
  if(report.issues.numErrors)throw fault(`Transferred GLB failed validation (${report.issues.numErrors} errors).`,422);
  const vertices=glb.json.meshes.reduce((total,mesh)=>total+mesh.primitives.reduce((sum,p)=>sum+glb.json.accessors[p.attributes.POSITION].count,0),0);
  return {sha256:digest(bytes),joints:skin.joints,vertices,validation:{errors:0,warnings:report.issues.numWarnings,visualReview:'pending'}};
}

/** Trusted loopback HTTP surface; uploads may call the Buffer service directly. */
export function createWeightTransferRoutes({directory,json,provenance,service}={}){
  service??=createWeightTransferService({directory,record:event=>provenance.append('library',event)});
  return async(req,res,url)=>{
    if(url.pathname!=='/api/avatar-weight-transfer')return false;
    try{
      const local=new Set(['localhost','127.0.0.1','[::1]']);let here;
      try{const host=req.headers.host;here=new URL(`http://${host}`);if(!local.has(here.hostname)||here.host!==host||here.pathname!=='/'||here.search||here.hash||(req.socket?.localPort&&Number(here.port||80)!==req.socket.localPort))throw Error();}
      catch{throw fault('Weight transfer requires this Studio loopback Host and port.',403);}
      if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin!==undefined&&req.headers.origin!==here.origin))throw fault('Open weight transfer from this Studio window.',403);
      res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
      if(req.method!=='POST')throw fault('Use POST.',405);
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw fault('Weight transfer requires application/json.',415);
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32768)throw fault('Weight-transfer request is too large.',413);chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('Invalid JSON.');}
      if(!body||typeof body!=='object'||Array.isArray(body))throw fault('Request must be an object.');
      if(Object.keys(body).some(k=>k.endsWith('_bytes')))throw fault('Binary input is supported by the local service, not this JSON endpoint.');
      const {action,...input}=body;let result;
      if(action==='status'){strict(input,[]);result=await service.status();}
      else if(action==='inspect')result=await service.inspect(input);
      else if(action==='submit')result=await service.submit(input,provenance.actorFrom(req));
      else if(action==='get'){strict(input,['id']);result=await service.get(input.id);}
      else throw fault('Unknown weight-transfer action.');
      json(res,200,result);
    }catch(error){json(res,error.status||500,{error:error.message});}
    return true;
  };
}
