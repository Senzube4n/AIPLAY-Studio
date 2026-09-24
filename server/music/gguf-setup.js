/** Optional native kit setup. No automatic downloads, Python, shell commands, or arbitrary URLs. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile, writeFile, mkdir, mkdtemp, stat, statfs, rename, lstat, realpath, rm, unlink, open} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {config} from '../config.js';
import {YUE_GGUF_VARIANTS, ggufFilesFor, YUE_GGUF_WEIGHTS, yueGgufStatus, parseRuntimeVersion, pickBackend} from './yue-gguf.js';
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
export const GGUF_LICENCE=Object.freeze({label:'YuE2 weights: licence file CC BY-NC 4.0; the authors say individuals may sell what it makes (15 Sep 2026) and companies need a commercial licence. Native code: Apache-2.0/MIT. CUDA: NVIDIA proprietary runtime terms.',
  url:'https://huggingface.co/audio-cpp/Yue2-3B-GGUF',
  cudaUrl:'https://docs.nvidia.com/cuda/eula/index.html'});
/* ONE ENGINE, THREE RUNTIMES — the card picks which one is downloaded.
 *
 * The weights are the same files on every card; only the audio.cpp binary
 * differs. NVIDIA keeps the pinned CUDA kit (fastest there). Every other card
 * gets audio.cpp's own official Vulkan build, which AMD, Intel and NVIDIA
 * drivers all run, and a machine with no card gets the official CPU build.
 * Both official archives are pinned by the SHA-256 GitHub publishes for them
 * (checked against a download 2026-09-18) and carry their MSVC runtime DLLs,
 * so neither needs the VC++ redistributable, CUDA, ROCm or Python. Nothing is
 * installed into ComfyUI or any Python environment. */
export const RUNTIME_KINDS=Object.freeze({
  cuda:Object.freeze({label:'NVIDIA CUDA',manifest:'yue-runtime-manifest.json',backend:'cuda',
    requirements:GGUF_REQUIREMENTS,licence:GGUF_LICENCE}),
  vulkan:Object.freeze({label:'Vulkan (AMD, Intel or NVIDIA)',manifest:'yue-runtime-manifest-vulkan.json',backend:'vulkan',
    requirements:Object.freeze({platform:'win32',arch:'x64',driver:'Any current AMD, Intel or NVIDIA graphics driver (they include Vulkan). The Visual C++ runtime ships inside the archive.'}),
    licence:Object.freeze({label:'YuE2 weights: licence file CC BY-NC 4.0; the authors say individuals may sell what it makes (15 Sep 2026) and companies need a commercial licence. Native code: Apache-2.0/MIT (official audio.cpp v0.8.1 release).',
      url:'https://huggingface.co/audio-cpp/Yue2-3B-GGUF'})}),
  cpu:Object.freeze({label:'CPU only',manifest:'yue-runtime-manifest-cpu.json',backend:'cpu',
    requirements:Object.freeze({platform:'win32',arch:'x64',driver:'No graphics card needed. Much slower than a GPU. The Visual C++ runtime ships inside the archive.'}),
    licence:Object.freeze({label:'YuE2 weights: licence file CC BY-NC 4.0; the authors say individuals may sell what it makes (15 Sep 2026) and companies need a commercial licence. Native code: Apache-2.0/MIT (official audio.cpp v0.8.1 release).',
      url:'https://huggingface.co/audio-cpp/Yue2-3B-GGUF'})}),
});
/** Pure: which runtime to install. An explicit choice wins; otherwise the card decides. */
export function runtimeKindFor({preferred='auto',vendor=null,cpuOnly=false}={}) {
  if (Object.hasOwn(RUNTIME_KINDS,preferred)) return preferred;
  if (vendor==='nvidia') return 'cuda';
  if (vendor) return 'vulkan';
  return cpuOnly ? 'cpu' : 'vulkan';
}
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

/** `kind` (at install) demands that backend; without it any YuE2-capable build passes. */
export async function probeNative(cli, {signal,kind=null}={}) {
  try {
    signal?.throwIfAborted();
    const r=await execFileClosed(cli,['--version'],{windowsHide:true,timeout:10000,maxBuffer:65536,signal});
    const version=r.stdout+'\n'+r.stderr, info=parseRuntimeVersion(version);
    if (!info.yue2) {
      return {ok:false,message:'This audio.cpp build is too old for YuE2 (needs v0.8.0 or newer). Use the native setup to install one.'};
    }
    const want=kind && RUNTIME_KINDS[kind]?.backend;
    if (want && !info.backends.includes(want)) {
      return {ok:false,message:`Expected an audio.cpp build with the ${want} backend; this one has ${info.backends.join(', ')||'none listed'}.`};
    }
    return {ok:true,version:version.trim(),backends:info.backends,cfgKey:info.cfgKey};
  } catch (err) {
    signal?.throwIfAborted();
    return {ok:false,message:(kind==='cuda'||!kind
      ? 'Native runtime could not start. Install Microsoft Visual C++ v14 x64 Redistributable and a CUDA 13.3-compatible NVIDIA driver, then retry. '
      : 'Native runtime could not start. Update the graphics driver, then retry. ')+String(err.message).slice(0,220)};
  }
}

export function validateRuntimeManifest(m) {
  const safeName=name=>typeof name==='string' && name.length<=180 && name.split('/').every(p=>
    /^[a-z0-9][a-z0-9._-]*$/i.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
  const sizeHash=f=>Number.isSafeInteger(f?.bytes) && f.bytes>0 && f.bytes<=2*1024**3 && /^[a-f0-9]{64}$/.test(f.sha256);
  // The CUDA kit is two archives (binaries + CUDA runtime); an official Vulkan/CPU release is one.
  if (m?.schema!==1 || !Array.isArray(m.archives) || m.archives.length<1 || m.archives.length>2) throw new Error('Native runtime manifest unavailable.');
  const names=new Set(), archives=new Set();let total=0;
  for (const a of m.archives) {
    if (!safeName(a.name) || a.name.includes('/') || !a.name.endsWith('.zip') || archives.has(a.name.toLowerCase())
      || !sizeHash(a) || !/^https:\/\//.test(a.url) || !Array.isArray(a.files) || !a.files.length || a.files.length>256) throw new Error('Invalid native runtime archive manifest.');
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
  runtimeKind() {
    return runtimeKindFor({preferred:this.settings.yueGguf?.runtime,vendor:this.settings.gpu?.vendor||null,
      cpuOnly:this.settings.engineInstall?.backend==='cpu'});
  }
  async manifest(kind=this.runtimeKind()) {
    const m=JSON.parse(await readFile(path.join(ROOT,'server/music',RUNTIME_KINDS[kind].manifest),'utf8'));
    return validateRuntimeManifest(m);
  }
  async status({quantization}={}) {
    const entries=await Promise.all(Object.keys(YUE_GGUF_VARIANTS).map(async q=>[q,await this.kitStatus({quantization:q})]));
    // Unnamed precision = the one that is installed (Q4 first), so a Q8-only
    // kit is not reported as "Q4_0 is not installed" by every caller that did not ask.
    if (quantization===undefined) quantization=entries.find(([,k])=>k.installed)?.[0]||'q4_0';
    variantFor(quantization);
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
    const kind=this.runtimeKind(), rk=RUNTIME_KINDS[kind];
    // What a render will actually run on: read from the INSTALLED binary, not the one setup would pick.
    const backend=runtime.ok ? pickBackend(runtime.backends||[],{vendor:this.settings.gpu?.vendor||null,
      preferred:this.settings.yueGguf?.backend}) : null;
    return {ok:true,...selected,selected,variants,activeQuantization:this.activeQuantization,state,progress:this.progress,
      message:this.pending ? this.message : ready ? `Native YuE2 ${selected.label} is installed and runs on ${backend==='cpu'?'the CPU':backend}. No ComfyUI or Python needed for this engine.`
        : kit.installed ? runtime.message || 'Native runtime changed; check setup again.'
        : this.state==='failed' || this.state==='cancelled' ? `${missing} ${operationMessage}` : missing,
      error:this.error||null,errorQuantization:this.error?this.lastQuantization:null,
      cleanupWarning:this.cleanupWarning||null,requirements:rk.requirements,licence:rk.licence,
      runtimeKind:kind,runtimeLabel:rk.label,backend,
      available:!!manifest && this.platform==='win32' && this.arch==='x64',
      paths:{runtime:kit.cli,models:kit.modelDir},runtimeVersion:runtime.version||null,
      integrity:'Files are hash-verified during installation. Readiness later checks sizes and the native version; it is not a new full-file hash scan.'};
  }
  /* NO LONGER NVIDIA ONLY. This used to refuse every non-NVIDIA card before
   * the download, because the only runtime it could install was CUDA. The YuE2
   * GGUF files are packed for audio.cpp (`general.architecture = audiocpp`), so
   * ComfyUI-GGUF still cannot load them — but audio.cpp itself runs on Vulkan
   * and CPU, and runtimeKind() now fetches the build that fits the card. */
  async start({acceptLicense=false,quantization='q4_0'}={}) {
    const variant=variantFor(quantization);
    if (acceptLicense!==true) throw new Error('Read and explicitly accept the model/runtime terms before installing.');
    if (this.platform!=='win32' || this.arch!=='x64') throw new Error('The packaged native runtimes are Windows x64 builds. On other systems, point AIPLAY_AUDIOCPP_CLI at your own audio.cpp v0.8+ build.');
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
    const probe=await this.probe(path.join(stage,'files','audiocpp_cli.exe'),{signal,kind:manifest.kind||'cuda'});
    if (!probe.ok) throw new Error(probe.message);
    signal.throwIfAborted();
    const cli=path.join(runtimeDir,'audiocpp_cli.exe');
    // Prepare every fallible output before activation. The receipt travels atomically with the runtime.
    await writeFile(path.join(stage,'files','installation.json'),JSON.stringify({installedAt:new Date().toISOString(),runtime:manifest,weights:YUE_GGUF_WEIGHTS,quantization,modelFile:variant.modelFile,runtimeKind:manifest.kind||'cuda',version:probe.version},null,2),{flag:'wx'});
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
