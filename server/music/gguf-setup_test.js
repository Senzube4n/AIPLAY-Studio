import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir,rename,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';

const root=await mkdtemp(path.join(os.tmpdir(),'aiplay-gguf-setup-test-'));
process.env.AIPLAY_APPDATA=path.join(root,'module-config');process.env.AIPLAY_RIG=path.join(root,'rig');
delete process.env.AIPLAY_AUDIOCPP_CLI;delete process.env.AIPLAY_YUE_GGUF_MODEL_DIR;delete process.env.AIPLAY_YUE_GGUF_ENABLED;
const {GgufSetup,validateRuntimeManifest,execFileClosed,modelDownloads}=await import('./gguf-setup.js');
const {verifiedDownload}=await import('./gguf-download.js');
after(async()=>{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  assert.match(path.basename(root),/^aiplay-gguf-setup-test-[A-Za-z0-9]+$/);
  await rm(root,{recursive:true,force:false});
});
const digest=b=>createHash('sha256').update(b).digest('hex');
const bytes=new Map([['audiocpp_cli.exe',Buffer.from('fake-cli')],['runtime.dll',Buffer.from('fake-dll')]]);
const manifest={schema:1,archives:[...bytes].map(([name,b],i)=>({name:`kit-${i}.zip`,url:`https://publisher.example/kit-${i}.zip`,bytes:3,sha256:digest('zip'),files:[{name,bytes:b.length,sha256:digest(b)}]}))};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(extra={}) {
  const dir=await mkdtemp(path.join(root,'case-'));
  const settings={dataDir:dir,settingsFile:path.join(dir,'settings.json'),yueGguf:{enabled:true,cli:'external-owned.exe',modelDir:'external-owned-models'}};
  await writeFile(settings.settingsFile,JSON.stringify({keep:'unchanged',audioCppCli:'external-owned.exe'}));
  const runtime=path.join(dir,'yue2-gguf','runtime');await mkdir(runtime,{recursive:true});await writeFile(path.join(runtime,'audiocpp_cli.exe'),'old-runtime');
  const setup=new GgufSetup({settings,platform:'win32',arch:'x64',models:()=>[],
    disk:async()=>({bavail:10**12,bsize:1}),probe:async()=>({ok:true,version:'mock cda0e CUDA'}),
    kitStatus:async()=>({installed:false,cli:settings.yueGguf.cli,modelDir:settings.yueGguf.modelDir}),
    download:async(_spec,dest)=>{await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,'zip');},
    extract:async(_archive,destination,list)=>{
      for(const f of JSON.parse(await readFile(list,'utf8'))){await mkdir(path.dirname(path.join(destination,f.name)),{recursive:true});await writeFile(path.join(destination,f.name),bytes.get(f.name));}
    },...extra});
  setup.manifest=async()=>validateRuntimeManifest(structuredClone(manifest));
  return {setup,settings,dir,runtime};
}
async function run(setup,quantization='q4_0'){assert.deepEqual(await setup.start({acceptLicense:true,quantization}),{started:true,quantization});await setup.pending;}
async function stages(f){return (await readdir(path.join(f.dir,'yue2-gguf'))).filter(n=>n.startsWith('runtime-stage-'));}

test('terms and supported platform refuse before manifest or download',async()=>{
  const f=await fixture();let calls=0;f.setup.manifest=async()=>{calls++;return manifest;};
  for(const value of [undefined,false,1,'true']) await assert.rejects(f.setup.start({acceptLicense:value}),/explicitly accept/);
  f.setup.platform='linux';await assert.rejects(f.setup.start({acceptLicense:true}),/Windows x64/);assert.equal(calls,0);
});
test('concurrent start claims one operation before the manifest read and cancellation retains its controller',async()=>{
  const f=await fixture();const gate=deferred();let reads=0,installs=0;
  f.setup.manifest=async()=>{reads++;await gate.promise;return manifest;};f.setup.install=async()=>{installs++;};
  const first=f.setup.start({acceptLicense:true});const second=f.setup.start({acceptLicense:true});
  assert.deepEqual(await first,{started:true,quantization:'q4_0'});assert.deepEqual(await second,{alreadyRunning:true,quantization:'q4_0'});
  const pending=f.setup.pending;assert.equal(f.setup.cancel().cancelling,true);gate.resolve();await pending;
  assert.equal(reads,1);assert.equal(installs,0);assert.equal(f.setup.state,'cancelled');assert.equal(f.setup.pending,null);assert.equal(f.setup.controller,null);
});

test('precision is strict and Q8 also requires explicit consent before manifest or download',async()=>{
  const f=await fixture();let calls=0;f.setup.manifest=async()=>{calls++;return manifest;};
  for(const quantization of [null,'Q8_0','q8','q5_0','',1,{},'__proto__']) {
    await assert.rejects(f.setup.start({acceptLicense:true,quantization}),/precision/);
    await assert.rejects(f.setup.status({quantization}),/precision/);
  }
  for(const acceptLicense of [undefined,false,'true',1]) await assert.rejects(f.setup.start({quantization:'q8_0',acceptLicense}),/explicitly accept/);
  assert.equal(calls,0);assert.equal(f.setup.pending,null);
});

test('pinned download manifests contain exactly the selected transformer and identical shared assets',()=>{
  const q4=modelDownloads(root),q8=modelDownloads(root,'q8_0');
  assert.equal(q4.length,6);assert.equal(q8.length,6);
  assert.equal(q4[0].name,'yue2-3b-q4_0.gguf');assert.equal(q8[0].name,'yue2-3b-q8_0.gguf');
  assert.equal(q8[0].bytes,4264186432);
  assert.equal(q8[0].sha256,'f3a9e3b197bfd05aa4ae6ab2d4b93f6d57c8cc0ea39a4af7d151f58697c7cfb6');
  assert.match(q8[0].url,/\/resolve\/eb116220931de5f373d024d48800338178c7de51\/yue2-3b-q8_0\.gguf$/);
  assert.deepEqual(q8.slice(1),q4.slice(1));
  assert.equal(q4.reduce((n,f)=>n+f.bytes,0),2933414997);
  assert.equal(q8.reduce((n,f)=>n+f.bytes,0),4531969109);
  assert.throws(()=>modelDownloads(root,'auto'),/precision|quantization/i);
});

test('different-precision concurrent start is refused, never acknowledged as its own install',async()=>{
  const f=await fixture(),gate=deferred();let installs=0;
  f.setup.manifest=async()=>{await gate.promise;return manifest;};
  f.setup.install=async(_manifest,_signal,q)=>{assert.equal(q,'q8_0');installs++;};
  assert.deepEqual(await f.setup.start({acceptLicense:true,quantization:'q8_0'}),{started:true,quantization:'q8_0'});
  await assert.rejects(f.setup.start({acceptLicense:true,quantization:'q4_0'}),{code:'setup_precision_busy'});
  assert.deepEqual(await f.setup.start({acceptLicense:true,quantization:'q8_0'}),{alreadyRunning:true,quantization:'q8_0'});
  assert.equal(f.setup.activeQuantization,'q8_0');
  const pending=f.setup.pending;gate.resolve();await pending;
  assert.equal(installs,1);assert.equal(f.setup.activeQuantization,null);
});

test('Q8-only readiness probes its runtime, distinguishes both variants and quotes chosen bytes',async()=>{
  const f=await fixture();const asked=[];let probes=0;
  f.setup.kitStatus=async({quantization})=>{asked.push(quantization);return {installed:quantization==='q8_0',cli:path.join(f.runtime,'audiocpp_cli.exe'),modelDir:'mock-models'};};
  f.setup.probe=async()=>{probes++;return {ok:true,version:'mock'};};
  const q8=await f.setup.status({quantization:'q8_0'}),q4=await f.setup.status();
  assert.equal(q8.ready,true);assert.equal(q8.quantization,'q8_0');assert.equal(q8.installed,true);
  assert.equal(q8.selected.modelFile,'yue2-3b-q8_0.gguf');assert.equal(q8.selected.ready,true);
  assert.equal(q4.ready,false);assert.equal(q4.installed,false);assert.equal(q4.quantization,'q4_0');
  assert.equal(q4.variants.q8_0.ready,true);assert.equal(q8.variants.q4_0.ready,false);
  assert.equal(q8.downloadBytes,4531969109+6);assert.equal(q4.downloadBytes,2933414997+6);
  assert.equal(q8.selected.downloadBytes,q8.downloadBytes);assert.equal(probes,1);
  assert.deepEqual(asked,['q4_0','q8_0','q4_0','q8_0']);
  f.setup.kitStatus=async({quantization})=>({installed:quantization==='q4_0',cli:path.join(f.runtime,'audiocpp_cli.exe'),modelDir:'mock-models'});
  f.setup.state='ready';f.setup.message='Installation verified.';
  const missing=await f.setup.status({quantization:'q8_0'});
  assert.equal(missing.ready,false);assert.equal(missing.installed,false);assert.equal(missing.variants.q4_0.ready,true);
  assert.match(missing.message,/Q8_0 is not installed/);
  assert.doesNotMatch(missing.message,/Installation verified/);
});

test('invalid model directory remains a useful unready status and failed precision is identified',async()=>{
  const f=await fixture();f.setup.kitStatus=async()=>({installed:false,cli:null,modelDir:null,why:['Configure an absolute native YuE2 model directory.']});
  f.setup.probe=async()=>assert.fail('an invalid kit must not be probed');
  const status=await f.setup.status({quantization:'q8_0'});
  assert.equal(status.ready,false);assert.equal(status.paths.models,null);
  assert.equal(status.downloadBytes,4531969109+6);assert.match(status.message,/Q8_0.*absolute native YuE2 model directory/);
  f.setup.manifest=async()=>{throw new Error('fixture manifest unavailable');};
  await run(f.setup,'q8_0');
  const other=await f.setup.status({quantization:'q4_0'});
  assert.equal(other.activeQuantization,null);assert.equal(other.errorQuantization,'q8_0');
  assert.match(other.message,/Q4_0 is not installed/);assert.match(other.message,/Q8_0 setup failed: fixture manifest unavailable/);
});

test('global pending install stays visible when inspecting the other precision; neither is ready',async()=>{
  const f=await fixture(),gate=deferred();
  f.setup.kitStatus=async()=>({installed:true,cli:path.join(f.runtime,'audiocpp_cli.exe'),modelDir:'mock-models'});
  const manifestRead=f.setup.manifest;let entered=false;
  f.setup.manifest=async()=>{if(!entered){entered=true;await gate.promise;}return manifestRead();};
  await f.setup.start({acceptLicense:true,quantization:'q8_0'});
  await Promise.resolve();
  const current=await f.setup.status({quantization:'q4_0'});
  assert.equal(current.activeQuantization,'q8_0');assert.equal(current.quantization,'q4_0');
  assert.equal(current.state,'downloading');assert.equal(current.ready,false);
  assert.equal(current.variants.q4_0.ready,false);assert.equal(current.variants.q8_0.ready,false);
  const pending=f.setup.pending;f.setup.cancel();gate.resolve();await pending;
  assert.equal(f.setup.state,'cancelled');assert.equal(f.setup.activeQuantization,null);
});

test('Q8 install resumes its own partial, reuses verified shared files, and preserves Q4',async()=>{
  const content=name=>Buffer.from(`fixture-${name}`),fetches=[];
  const models=(dir,q)=>modelDownloads(dir,q).map(f=>({name:f.name,url:`https://publisher.example/${f.name}`,
    bytes:content(f.name).length,sha256:digest(content(f.name)),dest:f.dest}));
  const f=await fixture({models,download:(spec,dest,options)=>verifiedDownload(spec,dest,{...options,fetchFn:async(url,request)=>{
    fetches.push({url,range:request.headers.Range});
    const body=spec.name.endsWith('.zip')?Buffer.from('zip'):content(spec.name);
    if(request.headers.Range){assert.equal(request.headers.Range,'bytes=3-');return new Response(body.subarray(3),{status:206,headers:{'content-range':`bytes 3-${body.length-1}/${body.length}`}});}
    return new Response(body);
  }})});
  const modelDir=path.join(f.dir,'yue2-gguf','models');await mkdir(path.join(modelDir,'sidecars'),{recursive:true});
  const existingQ4=path.join(modelDir,'yue2-3b-q4_0.gguf');await writeFile(existingQ4,'keep-existing-Q4');
  const q8=models(modelDir,'q8_0');await writeFile(q8[0].dest+'.part',content(q8[0].name).subarray(0,3));
  for(const shared of q8.slice(1)) await writeFile(shared.dest,content(shared.name));
  await run(f.setup,'q8_0');assert.equal(f.setup.state,'ready',f.setup.error);
  assert.equal(await readFile(existingQ4,'utf8'),'keep-existing-Q4');
  assert.deepEqual(await readFile(q8[0].dest),content(q8[0].name));
  assert.equal(fetches.length,3);assert.equal(fetches[0].range,'bytes=3-');
  assert.equal(fetches.some(x=>x.url.includes('q4_0')),false);
  const receipt=JSON.parse(await readFile(path.join(f.runtime,'installation.json'),'utf8'));
  assert.equal(receipt.quantization,'q8_0');assert.equal(receipt.modelFile,'yue2-3b-q8_0.gguf');
  await run(f.setup,'q8_0');assert.equal(f.setup.state,'ready',f.setup.error);
  assert.equal(fetches.length,3,'second install reuses every verified model/archive');
  assert.equal(await readFile(existingQ4,'utf8'),'keep-existing-Q4');
});
test('manifest failure releases the operation and a later retry can succeed',async()=>{
  const f=await fixture();const good=f.setup.manifest;f.setup.manifest=async()=>{throw new Error('manifest unavailable');};
  await run(f.setup);assert.equal(f.setup.state,'failed');assert.equal(f.setup.pending,null);
  f.setup.manifest=good;await run(f.setup);assert.equal(f.setup.state,'ready');
});
test('successful activation preserves old runtime, merges settings under the key config actually reads, and cleans only its stage',async()=>{
  const f=await fixture();await run(f.setup);assert.equal(f.setup.state,'ready');
  assert.equal(await readFile(path.join(f.runtime,'audiocpp_cli.exe'),'utf8'),'fake-cli');
  const names=await readdir(path.dirname(f.runtime));const backup=names.find(n=>n.startsWith('runtime-previous-'));assert.ok(backup);
  assert.equal(await readFile(path.join(path.dirname(f.runtime),backup,'audiocpp_cli.exe'),'utf8'),'old-runtime');
  const saved=JSON.parse(await readFile(f.settings.settingsFile,'utf8'));assert.equal(saved.keep,'unchanged');assert.equal(saved.audioCppCli,path.join(f.runtime,'audiocpp_cli.exe'));assert.equal(saved.yueGgufCli,undefined);
  assert.equal(f.settings.yueGguf.cli,saved.audioCppCli);assert.ok(JSON.parse(await readFile(path.join(f.runtime,'installation.json'),'utf8')).runtime);
  assert.deepEqual(await stages(f),[]);
});
test('malformed and non-object settings are rejected before downloading or changing runtime',async()=>{
  for(const text of ['[1]','null','42','{"broken":']){
    let downloads=0;const f=await fixture({download:async()=>{downloads++;}});await writeFile(f.settings.settingsFile,text);
    await run(f.setup);assert.equal(f.setup.state,'failed');assert.equal(downloads,0);
    assert.equal(await readFile(path.join(f.runtime,'audiocpp_cli.exe'),'utf8'),'old-runtime');assert.equal(await readFile(f.settings.settingsFile,'utf8'),text);
  }
});
test('missing VC/driver probe leaves old runtime and settings intact and cleans extraction stage',async()=>{
  const f=await fixture({probe:async()=>({ok:false,message:'missing prerequisite'})});const old=await readFile(f.settings.settingsFile,'utf8');
  await run(f.setup);assert.equal(f.setup.state,'failed');assert.match(f.setup.error,/prerequisite/);
  assert.equal(await readFile(path.join(f.runtime,'audiocpp_cli.exe'),'utf8'),'old-runtime');assert.equal(await readFile(f.settings.settingsFile,'utf8'),old);assert.deepEqual(await stages(f),[]);
});
test('failure moving staged runtime restores the exact previous runtime',async()=>{
  let failed=false;const f=await fixture({move:async(a,b)=>{if(!failed && a.includes('runtime-stage-') && path.basename(a)==='files'){failed=true;throw new Error('activation failure');}await rename(a,b);}});
  await run(f.setup);assert.equal(f.setup.state,'failed');assert.equal(await readFile(path.join(f.runtime,'audiocpp_cli.exe'),'utf8'),'old-runtime');assert.deepEqual(await stages(f),[]);
});
test('failure committing settings rolls back activated runtime without changing settings',async()=>{
  const f=await fixture({move:async(a,b)=>{if(a.includes('.yue-install-'))throw new Error('settings denied');await rename(a,b);}});const old=await readFile(f.settings.settingsFile,'utf8');
  await run(f.setup);assert.equal(f.setup.state,'failed');assert.equal(await readFile(path.join(f.runtime,'audiocpp_cli.exe'),'utf8'),'old-runtime');assert.equal(await readFile(f.settings.settingsFile,'utf8'),old);assert.deepEqual(await stages(f),[]);
  assert.deepEqual((await readdir(f.dir)).filter(n=>n.includes('.yue-install-')),[]);
});
test('cancellation after old runtime moves restores it and cannot commit the new runtime',async()=>{
  let setup;const f=await fixture({move:async(a,b)=>{await rename(a,b);if(path.basename(b).startsWith('runtime-previous-'))setup.cancel();}});setup=f.setup;
  await run(setup);assert.equal(setup.state,'cancelled');assert.equal(await readFile(path.join(f.runtime,'audiocpp_cli.exe'),'utf8'),'old-runtime');assert.deepEqual(await stages(f),[]);
});
test('cancellation during extraction awaits the injected child completion before removing its owned stage',async()=>{
  const gate=deferred(),entered=deferred();let destination;
  const f=await fixture({extract:async(_a,d,_l,{signal})=>{destination=d;await mkdir(d,{recursive:true});entered.resolve();await gate.promise;signal.throwIfAborted();}});
  await f.setup.start({acceptLicense:true});const pending=f.setup.pending;await entered.promise;f.setup.cancel();
  assert.ok(await stat(destination));assert.ok(f.setup.pending);gate.resolve();await pending;
  assert.equal(f.setup.state,'cancelled');assert.deepEqual(await stages(f),[]);assert.equal(await readFile(path.join(f.runtime,'audiocpp_cli.exe'),'utf8'),'old-runtime');
});
test('settings changed during a long download are merged freshly rather than replaced by the initial snapshot',async()=>{
  const f=await fixture();const download=f.setup.download;let changed=false;
  f.setup.download=async(...args)=>{await download(...args);if(!changed){changed=true;await writeFile(f.settings.settingsFile,JSON.stringify({keep:'new-value',unrelated:12}));}};
  await run(f.setup);const saved=JSON.parse(await readFile(f.settings.settingsFile,'utf8'));assert.equal(saved.keep,'new-value');assert.equal(saved.unrelated,12);
});
test('same-sized corrupt files are included in free-space requirements',async()=>{
  const f=await fixture({disk:async()=>({bavail:256*1024*1024+16,bsize:1})});
  const cache=path.join(f.dir,'yue2-gguf','downloads');await mkdir(cache,{recursive:true});for(const a of manifest.archives)await writeFile(path.join(cache,a.name),'bad');
  await run(f.setup);assert.equal(f.setup.state,'failed');assert.match(f.setup.error,/disk space/);
});
test('concurrent readiness probes are single-flight, and pending install is never ready',async()=>{
  const f=await fixture();const gate=deferred();let probes=0;
  f.setup.kitStatus=async()=>({installed:true,cli:path.join(f.runtime,'audiocpp_cli.exe'),modelDir:'mock-models'});
  f.setup.probe=async()=>{probes++;await gate.promise;return {ok:true,version:'mock'};};
  const statuses=[f.setup.status(),f.setup.status(),f.setup.status()];
  await new Promise(r=>setTimeout(r,20));gate.resolve();assert.equal((await Promise.all(statuses)).every(s=>s.ready),true);assert.equal(probes,1);
  f.setup.pending=Promise.resolve();assert.equal((await f.setup.status()).ready,false);f.setup.pending=null;
});
test('disappearing configured executable returns unready instead of a status error',async()=>{
  const f=await fixture();f.setup.kitStatus=async()=>({installed:true,cli:path.join(f.dir,'missing.exe'),modelDir:'mock-models'});
  assert.equal((await f.setup.status()).ready,false);
});
test('runtime manifest refuses paths, Windows aliases, duplicate names, missing CLI and excessive bounds',()=>{
  assert.equal(validateRuntimeManifest(structuredClone(manifest)).archives.length,2);
  for(const mutate of [m=>m.archives[0].name='../escape.zip',m=>m.archives[0].files[0].name='../escape.exe',m=>m.archives[0].files[0].name='NUL.txt',m=>m.archives[1].files[0].name='AUDIOCPP_CLI.EXE',m=>m.archives[0].files[0].bytes=2**40,m=>m.archives[0].files[0].name='other.exe']){
    const m=structuredClone(manifest);mutate(m);assert.throws(()=>validateRuntimeManifest(m),/manifest|executable|size/);
  }
});

test('abort callback cannot release the extraction barrier before actual child close',async()=>{
  const child=new EventEmitter();let callback,settled=false;
  const promise=execFileClosed('mock-child',[],{},(_file,_args,_opts,cb)=>{callback=cb;return child;});
  promise.then(()=>{settled=true;},()=>{settled=true;});
  const error=new Error('cancelled');error.name='AbortError';callback(error,'','');child.emit('error',error);
  await new Promise(r=>setTimeout(r,10));assert.equal(settled,false);
  child.emit('close',null,'SIGTERM');await assert.rejects(promise,{name:'AbortError'});assert.equal(settled,true);
});
test('process-close adapter preserves normal output and synchronous spawn failures',async()=>{
  const child=new EventEmitter();let callback;
  const promise=execFileClosed('mock-child',[],{},(_f,_a,_o,cb)=>{callback=cb;return child;});
  callback(null,'version','diagnostic');child.emit('close',0,null);
  assert.deepEqual(await promise,{stdout:'version',stderr:'diagnostic'});
  await assert.rejects(execFileClosed('mock-child',[],{},()=>{throw new Error('spawn refused');}),/spawn refused/);
});
