/** Previewable local fitting jobs; import/equip is a separate wardrobe operation. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,stat,rename} from 'node:fs/promises';
import {statSync} from 'node:fs';
import validator from 'gltf-validator';
import {config,weightTransferScriptPath,attachmentFitScriptPath} from '../config.js';
import {normalizeActor} from '../provenance.js';
import {readGlb,assertSkinned} from './glb.js';
import {toolkitScriptHelp} from './previz-toolkit.js';

export const FITTING_LIMITS=Object.freeze({bytes:64*1024*1024,timeoutMs:300000,clearance:[0,.03],max_displacement:[.001,.2],max_scale_change:[1,3]});
export const FITTING_DEFAULTS=Object.freeze({alignment:'bounds',clearance:.006,max_displacement:.1,max_scale_change:2});
// attachment_fit.py imports weight_transfer, which imports bpy, so neither is
// in this Apache-2.0 tree (see server/licence_test.js): config.js
// attachmentFitScriptPath() finds the fitter beside weight_transfer.py,
// outside the tree. The spawn puts that script's folder and this one on
// PYTHONPATH: the first so `import weight_transfer` loads the same script the
// weight-transfer service runs, the second for the stdlib-only unirig_adapter.
const meshDir=path.dirname(fileURLToPath(import.meta.url)),marker='AVATAR_FITTING_RESULT_JSON:';
const isFileSync=file=>{try{return statSync(file).isFile();}catch{return false;}};
const scriptMissing=(script,name,variables)=>fault(`Fitting needs ${name} at ${script}. It imports bpy, so this Apache-2.0 tree ships no copy of it. ${toolkitScriptHelp(name,variables)}`,503);
/** Both out-of-tree scripts the fitter needs, or the 503 sentence for the first one missing. */
export function fittingScripts(){
  const fit=attachmentFitScriptPath(),transfer=weightTransferScriptPath();
  // The variables in the order config.js reads them: unset, the fitter follows
  // weight_transfer.py, so a stale transfer variable is the one to name.
  if(!isFileSync(fit))throw scriptMissing(fit,'attachment_fit.py',['AIPLAY_ATTACHMENT_FIT_SCRIPT','AIPLAY_WEIGHT_TRANSFER_SCRIPT']);
  if(!isFileSync(transfer))throw scriptMissing(transfer,'weight_transfer.py',['AIPLAY_WEIGHT_TRANSFER_SCRIPT']);
  return {fit,transfer};
}
const hash=b=>createHash('sha256').update(b).digest('hex');
const sha=/^[a-f0-9]{64}$/,uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const ids={avatar:new RegExp('^av_'+uuid+'$'),target:new RegExp('^ft_'+uuid+'$'),job:new RegExp('^fit_'+uuid+'$')};
const fault=(message,status=400)=>Object.assign(new Error(message),{status});
const strict=(o,keys)=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!keys.includes(k)))throw fault('Unsupported fitting fields.');};
const validId=(id,kind)=>{if(typeof id!=='string'||!ids[kind].test(id))throw fault(`Invalid fitting ${kind} id.`);return id;};
const validHash=(value,name)=>{if(typeof value!=='string'||!sha.test(value))throw fault(`${name} must be an inspected SHA-256.`);return value;};

export function runFittingPython(python,args,{timeoutMs=FITTING_LIMITS.timeoutMs,spawnImpl=spawn}={}){
  return new Promise((resolve,reject)=>{
    let child,timer,done=false,stdout='',size=0;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
    // A missing script is a setup sentence, never a spawn (the service checks
    // first; this is the backstop for a direct caller).
    let scripts;try{scripts=fittingScripts();}catch(error){finish(error);return;}
    try{
      child=spawnImpl(python,['-u',scripts.fit,...args],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',
        PYTHONPATH:[path.dirname(scripts.transfer),meshDir,process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)}});
      timer=setTimeout(()=>{child.kill();finish(fault('Local fitting timed out; no attachment was admitted.',504));},timeoutMs);
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      const receive=out=>chunk=>{if(done)return;size+=Buffer.byteLength(chunk);if(size>1024*1024){child.kill();finish(fault('Fitting output exceeded its log limit.',502));return;}if(out)stdout+=chunk;};
      child.stdout.on('data',receive(true));child.stderr.on('data',receive(false));
      child.once('error',error=>finish(fault(`Cannot run Blender Python; set AIPLAY_AVATAR_PYTHON to an interpreter with bpy. ${error.code||error.message}`,503)));
      child.once('close',code=>{
        if(done)return;let result;try{const lines=stdout.split(/\r?\n/).filter(s=>s.startsWith(marker));if(lines.length!==1)throw Error();result=JSON.parse(lines[0].slice(marker.length));}catch{finish(fault('Fitting returned no unambiguous result.',502));return;}
        if(code!==0||result?.ok!==true){finish(fault(String(result?.error||'Local fitting failed.'),422));return;}finish(null,result);
      });
    }catch(error){finish(error);}
  });
}

async function checkedGlb(bytes,weighted=false){
  if(!Buffer.isBuffer(bytes)||bytes.length>FITTING_LIMITS.bytes)throw fault('Fitting asset exceeds 64 MiB.',413);
  const glb=readGlb(bytes);if(!glb.ok)throw fault(glb.why.join('; '));
  if(glb.json.buffers?.some(b=>b.uri!==undefined)||glb.json.images?.some(i=>i.uri!==undefined))throw fault('Embed every attachment resource.');
  if(weighted){const skin=assertSkinned(glb.json,glb.binData);if(!skin.ok)throw fault(`Fitted attachment has invalid weights: ${skin.why.join('; ')}`,422);
    const validation=await validator.validateBytes(new Uint8Array(bytes),{maxIssues:100,externalResourceFunction:async()=>{throw Error('External resources are disabled.');}});
    if(validation.issues.numErrors)throw fault(`Fitted GLB failed validation (${validation.issues.numErrors} errors).`,422);
    return {sha256:hash(bytes),joints:skin.joints,vertices:glb.json.meshes.reduce((n,m)=>n+m.primitives.reduce((sum,p)=>sum+glb.json.accessors[p.attributes.POSITION].count,0),0),validation:{errors:0,warnings:validation.issues.numWarnings},glb};}
  return {sha256:hash(bytes),glb};
}

export function createAvatarFittingService({directory,inspectAsset,python,run=runFittingPython,record=async()=>{}}={}){
  if(typeof inspectAsset!=='function')throw Error('Fitting needs the avatar service inspectAsset callback.');
  directory=path.resolve(directory||path.join(config.dataDir,'avatar-fitting'));
  const running=new Map();let reserved=false;
  const jobDir=id=>path.join(directory,'jobs',validId(id,'job'));
  const targetFile=id=>path.join(directory,'targets',validId(id,'target')+'.glb');
  async function interpreter(){const candidates=python||process.env.AIPLAY_AVATAR_PYTHON?[python||process.env.AIPLAY_AVATAR_PYTHON]:[config.mesh.unirigPython,config.mesh.python];
    let found=null;for(const candidate of candidates){if(typeof candidate!=='string'||!path.isAbsolute(candidate))continue;try{if((await stat(candidate)).isFile()){found=candidate;break;}}catch{}}
    if(!found)throw fault('Configure AIPLAY_AVATAR_PYTHON with local bpy and restart Studio. No packages or models are downloaded automatically.',503);
    // The scripts sit outside this tree, so an interpreter alone is not
    // availability. Checked HERE, before inspect or submit snapshot a byte or
    // submit writes a ledger event: a missing script is the same clean 503 as
    // a missing interpreter, with nothing on disk and no provenance.
    fittingScripts();return found;}
  async function avatar(id,expected){validId(id,'avatar');const asset=await inspectAsset(id);const checked=await checkedGlb(asset.bytes);if(expected&&expected!==checked.sha256)throw fault('Avatar changed since inspection.',409);return {...asset,sha256:checked.sha256};}
  async function target(input){
    if((input.target_path!==undefined)===(input.target_data_base64!==undefined))throw fault('Choose exactly one local part upload or target_path.');let bytes;
    if(input.target_path!==undefined){const file=input.target_path;if(typeof file!=='string'||!path.isAbsolute(file)||file.length>4096||file.includes('\0')||path.extname(file).toLowerCase()!=='.glb')throw fault('target_path must be an absolute local GLB path.');
      const info=await stat(file);if(!info.isFile()||info.size>FITTING_LIMITS.bytes)throw fault('Part exceeds 64 MiB.',413);bytes=await readFile(file);}
    else{const value=input.target_data_base64;if(typeof value!=='string'||!value||value.length>Math.ceil(FITTING_LIMITS.bytes/3)*4||value.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw fault('Upload must be a valid base64 GLB up to 64 MiB.');bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw fault('Upload is not canonical base64.');}
    await checkedGlb(bytes);return bytes;
  }
  async function save(row){const file=path.join(jobDir(row.id),'job.json'),temp=file+'.tmp';await writeFile(temp,JSON.stringify(row,null,2));for(let i=0;;i++){try{await rename(temp,file);return;}catch(e){if(i===5||!['EPERM','EBUSY'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,25*(i+1)));}}}
  async function inspect(input){
    strict(input,['avatar_id','target_path','target_data_base64']);const py=await interpreter(),base=await avatar(input.avatar_id);
    const bytes=input.target_path!==undefined||input.target_data_base64!==undefined?await target(input):null;
    const id='ft_'+randomUUID();await mkdir(path.join(directory,'targets'),{recursive:true});
    const dir=path.join(directory,'inspections',id);await mkdir(dir,{recursive:true});const reference=path.join(dir,'reference.glb');await writeFile(reference,base.bytes,{flag:'wx'});
    if(bytes)await writeFile(targetFile(id),bytes,{flag:'wx'});
    const report=await run(py,['--inspect','--reference',reference,...(bytes?['--target',targetFile(id)]:[])]);
    if(report.mode!=='inspect'||!sha.test(report.skeleton||'')||!Array.isArray(report.reference_surfaces)||!report.reference_surfaces.length)throw fault('Invalid fitting inventory.',502);
    return {...report,avatar_id:input.avatar_id,source_sha256:base.sha256,target_id:bytes?id:null,target_sha256:bytes?hash(bytes):null,limits:FITTING_LIMITS,defaults:FITTING_DEFAULTS};
  }
  async function submit(input,actor='system'){
    strict(input,['avatar_id','source_sha256','target_id','target_sha256','expected_skeleton','reference_mesh_node','reference_primitive',...Object.keys(FITTING_DEFAULTS),'name','source','license']);
    if(reserved)throw fault('A fitting job is already running.',409);
    validHash(input.source_sha256,'source_sha256');validHash(input.target_sha256,'target_sha256');validHash(input.expected_skeleton,'expected_skeleton');
    for(const key of ['reference_mesh_node','reference_primitive'])if(!Number.isInteger(input[key])||input[key]<0||input[key]>2048)throw fault(`Select a valid ${key}.`);
    if(!['keep','bounds'].includes(input.alignment))throw fault('alignment must be bounds or keep.');
    for(const key of ['clearance','max_displacement','max_scale_change'])if(typeof input[key]!=='number'||!Number.isFinite(input[key])||input[key]<FITTING_LIMITS[key][0]||input[key]>FITTING_LIMITS[key][1])throw fault(`Invalid ${key}.`);
    for(const [key,max] of [['name',100],['source',2000],['license',2000]])if(typeof input[key]!=='string'||!input[key].trim()||input[key].length>max)throw fault(`${key} is required (up to ${max} characters).`);
    reserved=true;
    try{
      const py=await interpreter(),base=await avatar(input.avatar_id,input.source_sha256),part=await readFile(targetFile(input.target_id));
      if(hash(part)!==input.target_sha256)throw fault('Uploaded part changed since inspection.',409);
      const id='fit_'+randomUUID(),dir=jobDir(id);await mkdir(dir,{recursive:true});
      const reference=path.join(dir,'reference.glb'),target=path.join(dir,'target.glb'),output=path.join(dir,'attachment.glb');
      await writeFile(reference,base.bytes,{flag:'wx'});await writeFile(target,part,{flag:'wx'});
      const options=Object.fromEntries(['expected_skeleton','reference_mesh_node','reference_primitive',...Object.keys(FITTING_DEFAULTS)].map(key=>[key,input[key]]));
      const row={id,state:'running',avatar_id:input.avatar_id,source_sha256:base.sha256,target_id:input.target_id,target_sha256:input.target_sha256,actor:normalizeActor(actor),name:input.name.trim(),source:input.source.trim(),license:input.license.trim(),options,createdAt:new Date().toISOString()};
      await record({type:'delegate',actor:row.actor,asset:`avatar-fit/${id}`,data:{operation:'fit-and-bind',sourceSha256:row.source_sha256,targetSha256:row.target_sha256,options}});await save(row);
      const initial=structuredClone(row);running.set(id,initial);
      const pending=(async()=>{try{
        const report=await run(py,['--reference',reference,'--target',target,'--output',output,'--options',JSON.stringify(options)]);
        if(report.mode!=='fit-and-bind'||report.sourceSha256!==row.source_sha256||report.targetSha256!==row.target_sha256||report.skeleton!==options.expected_skeleton||path.resolve(report.output||'')!==output
          ||report.referenceMeshNode!==options.reference_mesh_node||report.referencePrimitive!==options.reference_primitive||report.fit?.requiresVisualReview!==true
          ||!Number.isFinite(report.fit.maxDisplacement)||report.fit.maxDisplacement<0||report.fit.maxDisplacement>options.max_displacement
          ||report.fit.clearance!==options.clearance||!Number.isFinite(report.fit.scale)||report.fit.scale<=0)throw fault('Fitting report does not match the pinned job.',502);
        const bytes=await readFile(output),verified=await checkedGlb(bytes,true);
        if(verified.joints!==report.joints||verified.vertices!==report.vertices)throw fault('Fitting geometry counts disagree with the output.',502);
        if(hash(await readFile(reference))!==row.source_sha256||hash(await readFile(target))!==row.target_sha256)throw fault('Fitting snapshot changed during execution.',409);
        const metadata=verified.glb.json.extras?.aiplayAttachmentFit,weights=verified.glb.json.extras?.aiplayWeightTransfer;
        if(metadata?.sourceSha256!==row.source_sha256||metadata?.targetSha256!==row.target_sha256||weights?.referenceSha256!==row.source_sha256)throw fault('Fitted artifact lost its source provenance.',502);
        await record({type:'edit',actor:row.actor,asset:`avatar-fit/${id}`,data:{operation:'fit-and-bind',sourceSha256:row.source_sha256,targetSha256:row.target_sha256,sha256:verified.sha256,source:row.source,license:row.license,visualReview:'pending'}});
        Object.assign(row,{state:'complete',completedAt:new Date().toISOString(),result:{...report,output,sha256:verified.sha256,files:{glb:`/api/avatar-fitting/${id}/attachment.glb`},validation:verified.validation}});
      }catch(error){Object.assign(row,{state:'failed',completedAt:new Date().toISOString(),error:error.message});}
      finally{try{await save(row);}finally{running.delete(id);reserved=false;}}})();
      pending.catch(()=>{});return structuredClone(initial);
    }catch(error){reserved=false;throw error;}
  }
  async function get(id){const dir=jobDir(id);if(running.has(id))return structuredClone(running.get(id));let row;
    try{row=JSON.parse(await readFile(path.join(dir,'job.json'),'utf8'));}catch(e){if(e.code==='ENOENT')throw fault('Fitting job not found.',404);throw e;}
    if(row.id!==id)throw fault('Fitting journal changed.',409);
    if(row.state==='running')return {...row,state:'interrupted',error:'Studio restarted before the fitting result was saved.'};
    if(row.state==='complete'){await avatar(row.avatar_id,row.source_sha256);const checked=await checkedGlb(await readFile(path.join(dir,'attachment.glb')),true);if(checked.sha256!==row.result?.sha256)throw fault('Fitted attachment changed on disk.',409);row.result.output=path.join(dir,'attachment.glb');}
    return row;
  }
  async function file(id){const row=await get(id);if(row.state!=='complete')throw fault('Fitting output is not ready.',409);const bytes=await readFile(path.join(jobDir(id),'attachment.glb'));if(hash(bytes)!==row.result.sha256)throw fault('Fitted attachment changed on disk.',409);return {row,bytes};}
  async function status(){try{return {available:true,python:await interpreter(),running:reserved,limits:FITTING_LIMITS,defaults:FITTING_DEFAULTS};}catch(e){return {available:false,reason:e.message,limits:FITTING_LIMITS,defaults:FITTING_DEFAULTS};}}
  return {status,inspect,submit,get,file};
}

export function createAvatarFittingRoutes({directory,inspectAsset,json,provenance,service}={}){
  service??=createAvatarFittingService({directory,inspectAsset,record:event=>provenance.append('library',event)});
  return async(req,res,url)=>{
    if(url.pathname!=='/api/avatar-fitting'&&!url.pathname.startsWith('/api/avatar-fitting/'))return false;
    try{
      const local=new Set(['localhost','127.0.0.1','[::1]']);let here;try{const host=req.headers.host;here=new URL(`http://${host}`);if(!local.has(here.hostname)||here.host!==host||here.pathname!=='/'||here.search||here.hash||(req.socket?.localPort&&Number(here.port||80)!==req.socket.localPort))throw Error();}catch{throw fault('Fitting requires this Studio loopback Host and port.',403);}
      if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin!==undefined&&req.headers.origin!==here.origin))throw fault('Open fitting from this Studio window.',403);
      res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
      const asset=url.pathname.match(new RegExp('^/api/avatar-fitting/(fit_'+uuid+')/attachment\\.glb$'));
      if(req.method==='GET'&&asset){const {bytes}=await service.file(asset[1]);res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':bytes.length});res.end(bytes);return true;}
      if(url.pathname!=='/api/avatar-fitting')throw fault('Fitting route not found.',404);
      if(req.method!=='POST')throw fault('Use POST.',405);
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw fault('Fitting requires application/json.',415);
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>Math.ceil(FITTING_LIMITS.bytes/3)*4+32768)throw fault('Fitting upload is too large.',413);chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fault('Invalid JSON.');}if(!body||typeof body!=='object'||Array.isArray(body))throw fault('Request must be an object.');
      const {action,...input}=body;let result;
      if(action==='status'){strict(input,[]);result=await service.status();}
      else if(action==='inspect')result=await service.inspect(input);
      else if(action==='submit')result=await service.submit(input,provenance.actorFrom(req));
      else if(action==='get'){strict(input,['id']);result=await service.get(input.id);}
      else throw fault('Unknown fitting action.');json(res,200,result);
    }catch(error){json(res,error.status||500,{error:error.message});}return true;
  };
}
