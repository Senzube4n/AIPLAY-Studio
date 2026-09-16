/** Optional native kit setup. No automatic downloads, Python, shell commands, or arbitrary URLs. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile, mkdir, mkdtemp, stat, statfs, rename, lstat, realpath, rm, unlink, open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {config} from '../config.js';
import {YUE_GGUF_VARIANTS, ggufFilesFor, YUE_GGUF_WEIGHTS, yueGgufStatus} from './yue-gguf.js';
import {fileMatches, verifiedDownload} from './gguf-download.js';

// execFile's abort callback may precede actual child close. Do not release setup's
// barrier or remove extraction files until the process has stopped using them.
export function execFileClosed(file,args,options,spawn=execFile) {
  return new Promise((resolve,reject)=>{
    let result, failure;
    let child;
    try {child=spawn(file,args,options,(err,stdout,stderr)=>{failure=err;result={stdout,stderr};});}
    catch(err){reject(err);return;}
    child.once('error',err=>{failure=err;});
    child.once('close',()=>failure?reject(failure):resolve(result||{stdout:'',stderr:''}));
  });
}
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const GGUF_REQUIREMENTS=Object.freeze({platform:'win32',arch:'x64',
  vcRedistUrl:'https://aka.ms/vc14/vc_redist.x64.exe',
  driver:'NVIDIA driver compatible with CUDA 13.3. Lower-VRAM hardware remains experimental.'});
export const GGUF_LICENCE=Object.freeze({label:'YuE2 weights: CC BY-NC 4.0 · noncommercial use. Native code: Apache-2.0/MIT. CUDA: NVIDIA proprietary runtime terms.',
  url:'https://huggingface.co/audio-cpp/Yue2-3B-GGUF',
  cudaUrl:'https://docs.nvidia.com/cuda/eula/index.html'});
export const modelDownloads=(dir,quantization='q4_0')=>ggufFilesFor(quantization).map(f=>({name:f.name,bytes:f.declaredBytes,
  sha256:f.declaredSha256,gitBlob:f.gitBlob,
  url:`${YUE_GGUF_WEIGHTS.repository}/resolve/${YUE_GGUF_WEIGHTS.revision}/${f.name}`,
  dest:path.join(dir,f.name)}));
const variantFor=quantization=>{
  if(typeof quantization!=='string' || !Object.hasOwn(YUE_GGUF_VARIANTS,quantization)) {
    throw new Error('Native YuE2 precision must be q4_0 or q8_0. No alternate model was selected.');
  }
  return YUE_GGUF_VARIANTS[quantization];
};

export async function probeNative(cli, {signal}={}) {
  try {
    signal?.throwIfAborted();
    const r=await execFileClosed(cli,['--version'],{windowsHide:true,timeout:10000,maxBuffer:65536,signal});
    const version=r.stdout+'\n'+r.stderr;
    if (!/cda0e/i.test(version) || !/backends:.*cuda/i.test(version)) {
      return {ok:false,message:'Expected the pinned YuE2-capable cda0e3a CUDA build. Use the native setup to install it.'};
    }
    return {ok:true,version:version.trim()};
  } catch (err) {
    signal?.throwIfAborted();
    return {ok:false,message:'Native runtime could not start. Install Microsoft Visual C++ v14 x64 Redistributable and a CUDA 13.3-compatible NVIDIA driver, then retry. '+String(err.message).slice(0,220)};
  }
}

export function validateRuntimeManifest(m) {
  const safeName=name=>typeof name==='string' && name.length<=180 && name.split('/').every(p=>
    /^[a-z0-9][a-z0-9._-]*$/i.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
  const sizeHash=f=>Number.isSafeInteger(f?.bytes) && f.bytes>0 && f.bytes<=2*1024**3 && /^[a-f0-9]{64}$/.test(f.sha256);
  if (m?.schema!==1 || !Array.isArray(m.archives) || m.archives.length!==2) throw new Error('Native runtime manifest unavailable.');
  const names=new Set(), archives=new Set();let total=0;
  for (const a of m.archives) {
    if (!safeName(a.name) || a.name.includes('/') || !a.name.endsWith('.zip') || archives.has(a.name.toLowerCase())
      || !sizeHash(a) || !/^https:\/\//.test(a.url) || !Array.isArray(a.files) || !a.files.length || a.files.length>128) throw new Error('Invalid native runtime archive manifest.');
    archives.add(a.name.toLowerCase());
    for (const f of a.files) {
      if (!safeName(f.name) || !sizeHash(f) || names.has(f.name.toLowerCase())) throw new Error('Invalid native runtime file manifest.');
      names.add(f.name.toLowerCase());total+=f.bytes;
    }
  }
  if (!names.has('audiocpp_cli.exe') || total>4*1024**3) throw new Error('Invalid native runtime size or executable.');
  return m;
}

async function extractNative(archive,destination,list,{signal}) {
  signal.throwIfAborted();
  await execFileClosed('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.join(ROOT,'scripts/extract-yue-runtime.ps1'),'-Archive',archive,'-Destination',destination,'-Manifest',list],
    {windowsHide:true,timeout:180000,maxBuffer:65536,signal});
}

async function readSettings(file) {
  let text;try {text=await readFile(file,'utf8');} catch(err) {if(err.code==='ENOENT') return {text:null,value:{}};throw err;}
  let value;try {value=JSON.parse(text);} catch {throw new Error('Settings could not be read safely; existing runtime and settings retained.');}
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Settings must be a JSON object; existing runtime and settings retained.');
  return {text,value};
}

async function removeOwnedStage(stage,base) {
  // Only a directory created by this install may be removed, never a runtime/backup or resolved junction.
  const resolved=path.resolve(stage), parent=path.resolve(base);
  if (path.dirname(resolved)!==parent || !/^runtime-stage-[A-Za-z0-9]+$/.test(path.basename(resolved))) throw new Error('Unsafe installer stage cleanup.');
  const info=await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(await realpath(resolved))!==await realpath(parent)) throw new Error('Unsafe installer stage link.');
  await rm(resolved,{recursive:true,force:false});
}

export class GgufSetup {
  constructor({download=verifiedDownload,platform=process.platform,arch=process.arch,settings=config,
    probe=probeNative,extract=extractNative,matches=fileMatches,disk=statfs,move=rename,models=modelDownloads,
    kitStatus=({quantization='q4_0'}={})=>yueGgufStatus({settings:settings.yueGguf,quantization})}={}) {
    this.download=download;this.platform=platform;this.arch=arch;
    Object.assign(this,{settings,probe,extract,matches,disk,move,models,kitStatus});
    this.state='idle';this.progress=null;this.message='Install only the native YuE2 kit; other models are optional.';
    this.controller=null;this.pending=null;this.probeCache=null;this.activeQuantization=null;this.lastQuantization=null;
  }
  async manifest() {
    const m=JSON.parse(await readFile(path.join(ROOT,'server/music/yue-runtime-manifest.json'),'utf8'));
    return validateRuntimeManifest(m);
  }
  async status({quantization='q4_0'}={}) {
    variantFor(quantization);
    const entries=await Promise.all(Object.keys(YUE_GGUF_VARIANTS).map(async q=>[q,await this.kitStatus({quantization:q})]));
    const kits=Object.fromEntries(entries),kit=kits[quantization];
    // Q8 alone is a complete kit: do not require or probe the Q4 transformer.
    const runtimeKit=entries.find(([,candidate])=>candidate.installed)?.[1];
    let runtime={ok:false};
    if (runtimeKit && !this.pending) {
      const info=await stat(runtimeKit.cli).catch(()=>null);
      if (info) {
      const key=runtimeKit.cli+':'+info.mtimeMs+':'+info.size;
      if (!this.probeCache || this.probeCache.key!==key || Date.now()-this.probeCache.at>60000) {
        this.probeCache={key,at:Date.now(),result:this.probe(runtimeKit.cli)};
      }
      runtime=await this.probeCache.result;
      }
    }
    let manifest=null;try {manifest=await this.manifest();} catch { /* explicitly unavailable */ }
    const runtimeBytes=(manifest?.archives||[]).reduce((n,a)=>n+a.bytes,0);
    const variants=Object.fromEntries(entries.map(([q,candidate])=>[q,{
      quantization:q,...variantFor(q),installed:!!candidate.installed,
      ready:!!(candidate.installed && runtime.ok && !this.pending),
      // Size is a manifest fact, even when the configured model path is invalid.
      downloadBytes:ggufFilesFor(q).reduce((n,f)=>n+f.declaredBytes,0)+runtimeBytes,
      why:Array.isArray(candidate.why)?candidate.why.filter(reason=>typeof reason==='string'):[],
    }]));
    const selected=variants[quantization],{ready}=selected;
    const state=this.pending ? this.state : ready ? 'ready' : this.state==='ready' ? 'idle' : this.state;
    const missing=`Native YuE2 ${selected.label} is not installed or its configured files are unavailable. `
      +(selected.why.length?selected.why.slice(0,2).join(' '):'Install this precision; the other precision is not required.');
    const operationMessage=this.lastQuantization
      ? `Native YuE2 ${variantFor(this.lastQuantization).label} setup ${this.state}: ${this.message}` : this.message;
    return {ok:true,...selected,selected,variants,activeQuantization:this.activeQuantization,state,progress:this.progress,
      message:this.pending ? this.message : ready ? `Native YuE2 ${selected.label} is installed. No ComfyUI or Python needed for this engine.`
        : this.blocked() ? this.blocked()
        : kit.installed ? runtime.message || 'Native runtime changed; check setup again.'
        : this.state==='failed' || this.state==='cancelled' ? `${missing} ${operationMessage}` : missing,
      error:this.error||null,errorQuantization:this.error?this.lastQuantization:null,
      cleanupWarning:this.cleanupWarning||null,requirements:GGUF_REQUIREMENTS,licence:GGUF_LICENCE,
      available:!!manifest && this.platform==='win32' && this.arch==='x64' && !this.blocked(),
      blocked:this.blocked(),
      paths:{runtime:kit.cli,models:kit.modelDir},runtimeVersion:runtime.version||null,
      integrity:'Files are hash-verified during installation. Readiness later checks sizes and the native version; it is not a new full-file hash scan.'};
  }
  /* NVIDIA ONLY — SAID BEFORE 3.7 GB IS DOWNLOADED, NOT AFTER.
   *
   * install() downloads everything first and probes the CUDA runtime last, so
   * on an AMD or Intel card it used to fetch the whole kit and then fail with
   * "Native runtime could not start". And there is no ComfyUI fallback for the
   * files: they are packed for audio.cpp (`general.architecture = audiocpp`,
   * read from the Q4 file's header 2026-09-16), and ComfyUI-GGUF only accepts
   * image and text-encoder architectures. The card is read from settings
   * (setup.mjs records it); an unknown vendor is not refused. */
  static NON_NVIDIA='Native YuE2 GGUF runs only on NVIDIA cards: its audio.cpp runtime is built for CUDA, '
    +'and no ComfyUI node can load YuE2 GGUF files (they are packed for audio.cpp). On this card use YuE2 through '
    +'ComfyUI instead — "YuE2 3B for ComfyUI (int8)" on the Models screen is the small 3.96 GB build.';
  blocked() {
    const vendor=this.settings.gpu?.vendor;
    return vendor && vendor!=='nvidia' ? GgufSetup.NON_NVIDIA : null;
  }
  async start({acceptLicense=false,quantization='q4_0'}={}) {
    const variant=variantFor(quantization);
    if (this.blocked()) throw Object.assign(new Error(this.blocked()),{code:'setup_requires_nvidia'});
    if (acceptLicense!==true) throw new Error('Read and explicitly accept the model/runtime terms before installing.');
    if (this.platform!=='win32' || this.arch!=='x64') throw new Error('This packaged native preset supports Windows x64 with NVIDIA CUDA only.');
    if (this.pending) {
      if(this.activeQuantization!==quantization) throw Object.assign(new Error(
        `YuE2 ${variantFor(this.activeQuantization).label} setup is already running. Wait or explicitly cancel it before installing ${variant.label}.`),
        {code:'setup_precision_busy'});
      return {alreadyRunning:true,quantization};
    }
    const controller=new AbortController();
    this.controller=controller;this.activeQuantization=quantization;this.lastQuantization=quantization;this.state='downloading';this.error=null;this.cleanupWarning=null;this.progress=null;this.message=`Preparing verified native ${variant.label} downloads…`;
    // Reserve before the first asynchronous read. Concurrent requests share this operation.
    this.pending=Promise.resolve().then(async()=>{
      const manifest=await this.manifest();controller.signal.throwIfAborted();
      await this.install(manifest,controller.signal,quantization);
    }).then(()=>{this.state='ready';this.message='Installation verified.';},err=>{
      this.state=controller.signal.aborted?'cancelled':'failed';
      this.error=String(err.message||err);this.message=this.error;
    }).finally(()=>{this.pending=null;this.controller=null;this.probeCache=null;this.activeQuantization=null;});
    return {started:true,quantization};
  }
  cancel() {this.controller?.abort();return {ok:true,cancelling:!!this.pending};}
  async install(manifest,signal,quantization='q4_0') {
    const variant=variantFor(quantization);
    // Install in Studio's managed directory. Never modify a manually configured external kit.
    const base=path.join(this.settings.dataDir,'yue2-gguf');
    const modelDir=path.join(base,'models'),runtimeDir=path.join(base,'runtime'),cache=path.join(base,'downloads');
    await mkdir(cache,{recursive:true});
    await readSettings(this.settings.settingsFile);
    const downloads=[...this.models(modelDir,quantization),...manifest.archives.map(a=>({...a,dest:path.join(cache,a.name)}))];
    const total=downloads.reduce((n,f)=>n+f.bytes,0);
    // Temporary ZIPs and extracted CUDA files coexist. Estimate remaining allocation, not total installed footprint.
    let remaining=0;
    for (const f of downloads) {
      signal.throwIfAborted();
      // Invalid full-size destinations still need a second full allocation for replacement.
      if (!await this.matches(f.dest,f,{signal})) remaining+=f.bytes;
    }
    remaining+=manifest.archives.flatMap(a=>a.files).reduce((n,f)=>n+f.bytes,0)+256*1024*1024;
    const disk=await this.disk(base);
    if (disk.bavail*disk.bsize<remaining) throw new Error(`Not enough free disk space: allow ${Math.ceil(remaining/1e9)} GB more for download and extraction.`);
    let complete=0;
    for (const f of downloads) {
      signal.throwIfAborted();this.state='downloading';this.message=`Downloading or verifying ${f.name}`;
      await this.download(f,f.dest,{signal,onProgress:n=>{this.progress={received:complete+n,total,file:f.name};}});
      complete+=f.bytes;
    }
    this.state='verifying';this.message='Verifying and installing the native runtime…';
    const stage=await mkdtemp(path.join(base,'runtime-stage-'));
    let settingsTemp=null,settingsTempOwned=false;
    try {
    for (const archive of manifest.archives) {
      signal.throwIfAborted();
      const list=path.join(stage,archive.name+'.files.json');
      await writeFile(list,JSON.stringify(archive.files));
      await this.extract(path.join(cache,archive.name),path.join(stage,'files'),list,{signal});
    }
    const files=manifest.archives.flatMap(a=>a.files);
    for (const f of files) {
      signal.throwIfAborted();
      if (!await this.matches(path.join(stage,'files',f.name),f,{signal})) throw new Error(`Runtime integrity check failed: ${f.name}`);
    }
    // A failed VC/driver probe leaves the old runtime/settings intact and all verified downloads reusable.
    signal.throwIfAborted();
    const probe=await this.probe(path.join(stage,'files','audiocpp_cli.exe'),{signal});
    if (!probe.ok) throw new Error(probe.message);
    signal.throwIfAborted();
    const cli=path.join(runtimeDir,'audiocpp_cli.exe');
    // Prepare every fallible output before activation. The receipt travels atomically with the runtime.
    await writeFile(path.join(stage,'files','installation.json'),JSON.stringify({installedAt:new Date().toISOString(),runtime:manifest,weights:YUE_GGUF_WEIGHTS,quantization,modelFile:variant.modelFile,version:probe.version},null,2),{flag:'wx'});
    const settings=await readSettings(this.settings.settingsFile);
    const next={...settings.value,yueGgufEnabled:true,audioCppCli:cli,yueGgufModelDir:modelDir};
    settingsTemp=this.settings.settingsFile+'.yue-install-'+randomUUID()+'.tmp';
    const settingsHandle=await open(settingsTemp,'wx');settingsTempOwned=true;
    try {await settingsHandle.writeFile(JSON.stringify(next,null,2));await settingsHandle.sync();}
    finally {await settingsHandle.close();}
    const current=await readSettings(this.settings.settingsFile);
    if(current.text!==settings.text) throw new Error('Settings changed during setup; retry without changing the existing runtime.');
    signal.throwIfAborted();
    const backup=path.join(base,'runtime-previous-'+randomUUID());
    let backedUp=false,activated=false;
    try {
      const old=await lstat(runtimeDir).catch(err=>{if(err.code==='ENOENT')return null;throw err;});
      if(old && (!old.isDirectory() || old.isSymbolicLink())) throw new Error('Managed runtime must be a regular directory.');
      if(old){await this.move(runtimeDir,backup);backedUp=true;}
      signal.throwIfAborted();
      await this.move(path.join(stage,'files'),runtimeDir);activated=true;
      signal.throwIfAborted();
      await this.move(settingsTemp,this.settings.settingsFile);settingsTemp=null;
    } catch(err) {
      // No deletion of an existing runtime: restore it; a successful upgrade retains its backup.
      try {
        if(activated) await this.move(runtimeDir,path.join(stage,'files'));
        if(backedUp) await this.move(backup,runtimeDir);
      } catch {throw new Error('Native activation failed and automatic restoration failed. The previous runtime is retained at '+backup);}
      throw err;
    }
    // Respect explicit environment overrides even after a successful managed install.
    this.settings.yueGguf.cli=process.env.AIPLAY_AUDIOCPP_CLI || cli;
    this.settings.yueGguf.modelDir=process.env.AIPLAY_YUE_GGUF_MODEL_DIR || modelDir;
    this.settings.yueGguf.enabled=process.env.AIPLAY_YUE_GGUF_ENABLED!=='0';
    } finally {
      if(settingsTemp && settingsTempOwned) await unlink(settingsTemp).catch(()=>{});
      await removeOwnedStage(stage,base).catch(()=>{this.cleanupWarning='Temporary installer stage could not be removed: '+stage;});
    }
  }
}
