/** YuE2 GGUF on every card: the runtime is chosen by the card and the backend by the binary.
 *  Hermetic: no download, no GPU, no native CLI (the one real spawn is `node --version`). */
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=await mkdtemp(path.join(os.tmpdir(),'aiplay-gguf-backend-test-'));
process.env.AIPLAY_APPDATA=path.join(root,'appdata');process.env.AIPLAY_RIG=path.join(root,'rig');
delete process.env.AIPLAY_AUDIOCPP_CLI;delete process.env.AIPLAY_YUE_GGUF_BACKEND;delete process.env.AIPLAY_YUE_GGUF_RUNTIME;
const {parseRuntimeVersion,pickBackend,buildGgufArgs,validateGgufRequest,renderGgufSong,YUE_GGUF_FILES,readRuntime}=await import('./yue-gguf.js');
const {GgufSetup,RUNTIME_KINDS,runtimeKindFor,validateRuntimeManifest,probeNative}=await import('./gguf-setup.js');
after(async()=>{
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
  await rm(root,{recursive:true,force:true});
});
const HERE=path.dirname(fileURLToPath(import.meta.url));

const PINNED='audio.cpp 0.7.4-dev-cda0e-sheetsage2\ngit: cda0e3a 2026-09-12\nbuild: Release, msvc 19.44, Windows AMD64\nbackends: cpu,cuda\n';
const VULKAN='audio.cpp 0.8.1\ngit: f2b4937 2026-09-17\nbuild: Release, msvc 19.44, Windows AMD64\nbackends: cpu,vulkan\n';

test('the version line says which backends a build has, whether it knows YuE2, and its cfg option name',()=>{
  const pinned=parseRuntimeVersion(PINNED);
  assert.deepEqual(pinned.backends,['cpu','cuda']);
  assert.equal(pinned.yue2,true);assert.equal(pinned.cfgKey,'cfg_scale');
  const vk=parseRuntimeVersion(VULKAN);
  assert.deepEqual(vk.backends,['cpu','vulkan']);assert.equal(vk.version,'0.8.1');
  assert.equal(vk.yue2,true);assert.equal(vk.cfgKey,'guidance_scale');
  assert.equal(parseRuntimeVersion('audio.cpp 0.7.3\nbackends: cpu,vulkan').yue2,false,'YuE2 merged upstream in v0.8.0');
  assert.deepEqual(parseRuntimeVersion('audio.cpp 0.8.1\nbackends: cpu,rocm').backends,['cpu','hip'],'rocm is an alias for hip');
  assert.deepEqual(parseRuntimeVersion('').backends,[]);
});

test('the backend fits the card: never CUDA on AMD, the fastest one the binary has otherwise',()=>{
  assert.equal(pickBackend(['cpu','vulkan'],{vendor:'amd'}),'vulkan');
  assert.equal(pickBackend(['cpu','hip'],{vendor:'amd'}),'hip');
  assert.equal(pickBackend(['cpu','cuda'],{vendor:'amd'}),'cpu','a CUDA build on an AMD card falls to the CPU, not to a crash');
  assert.equal(pickBackend(['cpu','cuda'],{vendor:'nvidia'}),'cuda');
  assert.equal(pickBackend(['cpu','vulkan'],{vendor:'nvidia'}),'vulkan');
  assert.equal(pickBackend(['cpu','vulkan'],{vendor:'intel'}),'vulkan');
  assert.equal(pickBackend(['cpu','vulkan'],{vendor:'amd',preferred:'cpu'}),'cpu','an explicit choice wins');
  assert.equal(pickBackend(['cpu','vulkan'],{vendor:'amd',preferred:'cuda'}),'vulkan','but only when the build has it');
  assert.equal(pickBackend([],{vendor:null}),'cuda','an unreadable build is the pinned CUDA kit');
});

test('the command line carries the chosen backend and the build\'s own cfg option',()=>{
  const r=validateGgufRequest({style:'warm pop',lyrics:'la la la',cfg_scale:1.5});
  const base={modelDir:'C:/m',threads:8,output:'C:/o/song.wav'};
  const vk=buildGgufArgs(r,{...base,backend:'vulkan',cfgKey:'guidance_scale'});
  assert.equal(vk[vk.indexOf('--backend')+1],'vulkan');
  assert.ok(vk.includes('guidance_scale=1.5'));assert.ok(!vk.some(a=>a.startsWith('cfg_scale=')));
  const legacy=buildGgufArgs(r,base);
  assert.equal(legacy[legacy.indexOf('--backend')+1],'cuda');assert.ok(legacy.includes('cfg_scale=1.5'));
  assert.throws(()=>buildGgufArgs(r,{...base,backend:'directml'}),{refusal:'request'});
});

test('an AMD machine renders on Vulkan, and the receipt says so',async()=>{
  const settings={enabled:true,cli:path.join(root,'audiocpp_cli.exe'),modelDir:path.join(root,'models'),threads:8,vendor:'amd',backend:'auto'};
  const statFn=async(file)=>{
    if(file===settings.cli) return {isFile:()=>true,size:100};
    const f=YUE_GGUF_FILES.find(x=>path.join(settings.modelDir,x.name)===file);
    if(!f) throw Object.assign(new Error('nope'),{code:'ENOENT'});
    return {isFile:()=>true,size:f.declaredBytes};
  };
  let seen;
  const wav=()=>{const b=Buffer.alloc(44+32);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
    b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);
    b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32,40);return b;};
  const result=await renderGgufSong({style:'warm pop',lyrics:'la la la',cfg_scale:2,out:path.join(root,'renders')},{
    settings,statFn,runtimeInfo:async()=>parseRuntimeVersion(VULKAN),
    openSidecar:async()=>{throw Object.assign(new Error('none'),{code:'ENOENT'});},
    prov:{append:async(_s,e)=>({id:'x',...e})},
    runner:async(args)=>{seen=args;await writeFile(args[args.indexOf('--out')+1],wav());return {};}});
  assert.equal(seen[seen.indexOf('--backend')+1],'vulkan');
  assert.ok(seen.includes('guidance_scale=2'));
  assert.equal(result.record.runtime.backend,'vulkan');assert.equal(result.record.runtime.version,'0.8.1');
});

test('the card picks the runtime to install; an explicit choice wins',()=>{
  assert.equal(runtimeKindFor({vendor:'nvidia'}),'cuda');
  assert.equal(runtimeKindFor({vendor:'amd'}),'vulkan');
  assert.equal(runtimeKindFor({vendor:'intel'}),'vulkan');
  assert.equal(runtimeKindFor({vendor:null,cpuOnly:true}),'cpu');
  assert.equal(runtimeKindFor({vendor:null}),'vulkan');
  assert.equal(runtimeKindFor({vendor:'amd',preferred:'cpu'}),'cpu');
  assert.equal(runtimeKindFor({vendor:'amd',preferred:'nonsense'}),'vulkan');
});

test('the official Vulkan and CPU runtimes are pinned to the digests GitHub publishes',async()=>{
  const official={
    vulkan:['audio-v0.8.1-bin-windows-x64-vulkan.zip',58059664,'c787971e025ba8ef900f0482a2cc36a049367081fe89f4841aae521a0b49de32'],
    cpu:['audio-v0.8.1-bin-windows-x64-cpu.zip',23692614,'8b9f3d28db8d4a86d00c2380d08a8152a906a392139267a9c1df9d89db9fb098'],
  };
  for(const [kind,[name,bytes,sha]] of Object.entries(official)){
    const m=validateRuntimeManifest(JSON.parse(await readFile(path.join(HERE,RUNTIME_KINDS[kind].manifest),'utf8')));
    assert.equal(m.kind,kind);assert.equal(m.archives.length,1);
    const a=m.archives[0];
    assert.equal(a.name,name);assert.equal(a.bytes,bytes);assert.equal(a.sha256,sha);
    assert.equal(a.url,`https://github.com/0xShug0/audio.cpp/releases/download/v0.8.1/${name}`);
    assert.ok(a.files.some(f=>f.name==='audiocpp_cli.exe'));
    assert.ok(a.files.some(f=>f.name==='vcruntime140.dll'),'the MSVC runtime ships inside, so no redistributable is needed');
  }
  // The CUDA kit is unchanged and still validates.
  assert.equal(validateRuntimeManifest(JSON.parse(await readFile(path.join(HERE,RUNTIME_KINDS.cuda.manifest),'utf8'))).archives.length,2);
});

test('setup no longer refuses an AMD card, and offers it the Vulkan runtime',async()=>{
  const dir=await mkdtemp(path.join(root,'setup-'));
  const settings={dataDir:dir,settingsFile:path.join(dir,'settings.json'),gpu:{vendor:'amd'},yueGguf:{enabled:true,cli:'x.exe',modelDir:'m',runtime:'auto'}};
  const setup=new GgufSetup({settings,platform:'win32',arch:'x64',
    kitStatus:async()=>({installed:false,cli:'x.exe',modelDir:'m',why:[]})});
  const s=await setup.status();
  assert.equal(s.runtimeKind,'vulkan');assert.equal(s.available,true);assert.equal(s.blocked,undefined);
  assert.ok(!/NVIDIA/.test(s.licence.label),'no NVIDIA terms for a runtime that contains no NVIDIA code');
  assert.equal((await setup.manifest()).kind,'vulkan');
  // The only refusal left before a download is the licence.
  await assert.rejects(setup.start({acceptLicense:false}),/accept/);
  settings.gpu.vendor='nvidia';
  assert.equal((await setup.status()).runtimeKind,'cuda');
});

test('a build that cannot run YuE2 is refused by name, not by vendor',async()=>{
  // `node --version` answers like an old binary with no audio.cpp version line.
  const r=await probeNative(process.execPath);
  assert.equal(r.ok,false);assert.match(r.message,/too old for YuE2/);
});

test('the runtime is read once per file identity and never throws',async()=>{
  let calls=0;
  const execFileFn=(_f,_a,_o,cb)=>{calls++;cb(null,VULKAN,'');};
  const statFn=async()=>({mtimeMs:1,size:2});
  const a=await readRuntime('C:/rt/a.exe',{statFn,execFileFn});
  const b=await readRuntime('C:/rt/a.exe',{statFn,execFileFn});
  assert.equal(calls,1);assert.deepEqual(a,b);assert.deepEqual(a.backends,['cpu','vulkan']);
  const missing=await readRuntime('C:/rt/missing.exe',{statFn:async()=>{throw new Error('ENOENT');},execFileFn});
  assert.deepEqual(missing.backends,[]);
  const broken=await readRuntime('C:/rt/b.exe',{statFn,execFileFn:(_f,_a,_o,cb)=>cb(new Error('no'))});
  assert.deepEqual(broken.backends,[]);
});

test('the pages say which card the engine runs on instead of "NVIDIA only"',async()=>{
  const app=await readFile(path.join(HERE,'../../web/app.js'),'utf8');
  const html=await readFile(path.join(HERE,'../../web/index.html'),'utf8');
  assert.ok(!app.includes('NVIDIA only'));
  assert.match(html,/id="ggufSetupRuntime"/);assert.match(html,/id="ggufCudaTerms" hidden/);
  assert.match(app,/cudaTerms\.hidden = s\.runtimeKind !== "cuda"/);
});

const {ggufLogPhase,estimateGgufPhases,ggufEta,GGUF_PHASES}=await import('./yue-gguf.js');

test('the runtime\'s timing lines name the phase that just ended; nothing else does',()=>{
  assert.equal(ggufLogPhase('[TIMING ts=1726650000.123] yue2.ar.init_ms 4120.5'),'load');
  assert.equal(ggufLogPhase('[TIMING ts=1] yue2.plan_ms 800'),'plan');
  assert.equal(ggufLogPhase('[TIMING ts=1] yue2.semantic_ms 51000\r'),'semantic');
  assert.equal(ggufLogPhase('[TIMING ts=1] yue2.nar_ms 9000'),'nar');
  assert.equal(ggufLogPhase('[TIMING ts=1] yue2.vae_decode_ms 1200'),'decode');
  for (const line of ['[TIMING ts=1] yue2.semantic.tokens 2100','[TRACE ts=1] yue2.plan_ms 5','yue2.plan_ms 5','','la la la'])
    assert.equal(ggufLogPhase(line),null,line);
});

const run=(q,extra={})=>({quantization:q,backend:'vulkan',cot:'full',narSteps:32,lyricsChars:300,
  phases:{load:5,plan:4,semantic:40,nar:10,decode:3},...extra});
test('the estimate comes from this machine\'s runs of the same kind, scaled by lyric length',()=>{
  assert.equal(estimateGgufPhases([],{quantization:'q8_0',backend:'vulkan'}),null,'no history, no invented figure');
  const e=estimateGgufPhases([run('q8_0'),run('q8_0',{phases:{load:7,plan:4,semantic:60,nar:10,decode:3}})],
    {quantization:'q8_0',backend:'vulkan',cot:'full',narSteps:32,lyricsChars:600});
  assert.equal(e.load,6,'loading does not scale with lyrics');
  assert.equal(e.semantic,100,'twice the lyrics, twice the singing');
  assert.equal(estimateGgufPhases([run('q8_0')],{quantization:'q8_0',backend:'vulkan',cot:'off',lyricsChars:300}).plan,0);
  assert.equal(estimateGgufPhases([run('q8_0')],{quantization:'q8_0',backend:'vulkan',cot:'full',narSteps:16,lyricsChars:300}).nar,5);
  // Another precision on the same backend is better than nothing; another backend is not used.
  assert.ok(estimateGgufPhases([run('q4_0')],{quantization:'q8_0',backend:'vulkan',lyricsChars:300}));
  assert.equal(estimateGgufPhases([run('q8_0',{backend:'cuda'})],{quantization:'q8_0',backend:'vulkan'}),null);
});

test('the ETA counts down inside a phase and never reaches 100% before the WAV exists',()=>{
  const est={load:5,plan:5,semantic:40,nar:10,decode:0};
  assert.deepEqual(ggufEta(null,'load',0,0),{overall:null,etaSeconds:null});
  assert.equal(ggufEta(est,'load',0,0).etaSeconds,60);
  assert.equal(ggufEta(est,'semantic',10,20).etaSeconds,40);
  const late=ggufEta(est,'decode',50,200);
  assert.equal(late.etaSeconds,1);assert.ok(late.overall<1);
});

test('a render reports each phase as its timing line arrives, and teaches the next estimate',async()=>{
  const settings={enabled:true,cli:path.join(root,'audiocpp_cli.exe'),modelDir:path.join(root,'models'),threads:8,vendor:'amd',backend:'auto'};
  const statFn=async(file)=>{
    if(file===settings.cli) return {isFile:()=>true,size:100};
    const f=YUE_GGUF_FILES.find(x=>path.join(settings.modelDir,x.name)===file);
    if(!f) throw Object.assign(new Error('nope'),{code:'ENOENT'});
    return {isFile:()=>true,size:f.declaredBytes};
  };
  const wav=()=>{const b=Buffer.alloc(44+32);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
    b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);
    b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32,40);return b;};
  const stored=[];const timings={read:async()=>[...stored],add:async(row)=>{stored.push(row);}};
  const render=async(stages)=>renderGgufSong({style:'warm pop',lyrics:'la la la',out:path.join(root,'renders'),
    onProgress:(ev)=>stages.push(ev)},{settings,statFn,timings,runtimeInfo:async()=>parseRuntimeVersion(VULKAN),
    openSidecar:async()=>{throw Object.assign(new Error('none'),{code:'ENOENT'});},prov:{append:async(_s,e)=>({id:'x',...e})},
    runner:async(args,{onStdout})=>{
      assert.ok(args.includes('--log'));
      // Split mid-line on purpose: the parser must reassemble lines across chunks.
      onStdout('[TIMING ts=1] yue2.ar.init_ms 1\n[TIMING ts=1] yue2.pl');
      onStdout('an_ms 1\r\n[TIMING ts=1] yue2.semantic.tokens 99\n[TIMING ts=1] yue2.semantic_ms 1\n');
      onStdout('[TIMING ts=1] yue2.nar_ms 1\n[TIMING ts=1] yue2.vae_decode_ms 1\n');
      await writeFile(args[args.indexOf('--out')+1],wav());return {};}});
  const first=[];const result=await render(first);
  assert.deepEqual(first.map(e=>e.stage),['load','plan','semantic','nar','decode','verify']);
  assert.ok(first.every(e=>e.etaSeconds===null),'the first render has nothing to estimate from');
  assert.deepEqual(Object.keys(result.record.phaseSeconds||{}),[...GGUF_PHASES]);
  assert.equal(stored.length,1);assert.equal(stored[0].backend,'vulkan');
  const second=[];await render(second);
  assert.ok(second.some(e=>Number.isFinite(e.etaSeconds)),'the second render has an ETA');
});

test('a Q8-only kit is not reported or refused as a missing Q4',async()=>{
  const index=await readFile(path.join(HERE,'../index.js'),'utf8');
  const app=await readFile(path.join(HERE,'../../web/app.js'),'utf8');
  assert.match(index,/const kit=await ggufSetup\.status\(\{quantization:named\?nativeJob\.quantization:undefined\}\);/);
  assert.match(index,/if \(!named && kit\.quantization\) nativeJob\.quantization=kit\.quantization;/);
  assert.match(app,/if \(!ggufPrecisionPicked && installed && !response\.variants\[ggufPrecision\(\)\]\?\.ready\) selectGgufPrecision\(installed, false\);/);
});
