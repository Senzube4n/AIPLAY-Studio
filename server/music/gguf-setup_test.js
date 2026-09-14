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
const {GgufSetup,validateRuntimeManifest,execFileClosed}=await import('./gguf-setup.js');
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
async function run(setup){assert.deepEqual(await setup.start({acceptLicense:true}),{started:true});await setup.pending;}
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
  assert.deepEqual(await first,{started:true});assert.deepEqual(await second,{alreadyRunning:true});
  const pending=f.setup.pending;assert.equal(f.setup.cancel().cancelling,true);gate.resolve();await pending;
  assert.equal(reads,1);assert.equal(installs,0);assert.equal(f.setup.state,'cancelled');assert.equal(f.setup.pending,null);assert.equal(f.setup.controller,null);
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
