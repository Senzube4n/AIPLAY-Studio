import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm,mkdir} from 'node:fs/promises';
import {Writable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileMatches,verifiedDownload} from './gguf-download.js';
const content=Buffer.from('native-music-test-content');
const spec={url:'https://publisher.example/model',bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')};
const owned=[];
const temp=async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'aiplay-gguf-fetch-'));owned.push(dir);return path.join(dir,'model.gguf');};
after(async()=>{for(const dir of owned){assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^aiplay-gguf-fetch-[A-Za-z0-9]+$/);await rm(dir,{recursive:true,force:false});}});
test('complete verified download and reuse without network',async()=>{
  const dest=await temp();let calls=0;
  const fetchFn=async()=>{calls++;return new Response(content);};
  await verifiedDownload(spec,dest,{fetchFn});
  assert.deepEqual(await readFile(dest),content);
  assert.equal((await verifiedDownload(spec,dest,{fetchFn})).reused,true);assert.equal(calls,1);
});
test('valid partial resumes at exact offset',async()=>{
  const dest=await temp();await writeFile(dest+'.part',content.subarray(0,5));
  await verifiedDownload(spec,dest,{fetchFn:async(_url,opts)=>{
    assert.equal(opts.headers.Range,'bytes=5-');
    return new Response(content.subarray(5),{status:206,headers:{'content-range':`bytes 5-${content.length-1}/${content.length}`}});
  }});assert.equal(await fileMatches(dest,spec),true);
});
test('ignored Range restarts safely',async()=>{
  const dest=await temp();await writeFile(dest+'.part','partial');
  await verifiedDownload(spec,dest,{fetchFn:async()=>new Response(content)});
  assert.equal(await fileMatches(dest,spec),true);
});
test('incorrect resume range is refused without overwriting old complete file',async()=>{
  const dest=await temp();await writeFile(dest,'old-user-file');await writeFile(dest+'.part','part');
  await assert.rejects(verifiedDownload(spec,dest,{fetchFn:async()=>new Response(content,{status:206,headers:{'content-range':`bytes 0-${content.length-1}/${content.length}`}})}),/resume range/);
  assert.equal(await readFile(dest,'utf8'),'old-user-file');
});
test('same-size corruption fails checksum and removes corrupt partial only',async()=>{
  const dest=await temp();await writeFile(dest,'old-file');
  await assert.rejects(verifiedDownload(spec,dest,{fetchFn:async()=>new Response(Buffer.alloc(content.length))}),/checksum/);
  assert.equal(await readFile(dest,'utf8'),'old-file');assert.equal(await stat(dest+'.part').catch(()=>null),null);
});
test('Git blob sidecar identity is verified as blob header plus bytes',async()=>{
  const dest=await temp();const gitBlob=createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  await verifiedDownload({...spec,gitBlob,sha256:undefined},dest,{fetchFn:async()=>new Response(content)});
  assert.equal(await fileMatches(dest,{bytes:content.length,gitBlob}),true);
});
test('aborted install never starts a network download',async()=>{
  const signal=AbortSignal.abort();let called=false;
  await assert.rejects(verifiedDownload(spec,await temp(),{signal,fetchFn:()=>{called=true;}}));assert.equal(called,false);
});
test('manifest cannot provide an arbitrary insecure download',async()=>{
  await assert.rejects(verifiedDownload({...spec,url:'file:///private'},await temp()),/manifest/);
});

test('abort during complete partial verification cannot promote over an old destination',async()=>{
  const dest=await temp();await writeFile(dest,'old-file');await writeFile(dest+'.part',content);const c=new AbortController();
  await assert.rejects(verifiedDownload(spec,dest,{signal:c.signal,matches:async(file,s)=>{
    const valid=await fileMatches(file,s);if(file.endsWith('.part'))c.abort();return valid;
  },fetchFn:()=>assert.fail('no network needed')}),{name:'AbortError'});
  assert.equal(await readFile(dest,'utf8'),'old-file');assert.deepEqual(await readFile(dest+'.part'),content);
});
test('abort during post-download hash cannot promote or remove its completed partial',async()=>{
  const dest=await temp();await writeFile(dest,'old-file');const c=new AbortController();
  await assert.rejects(verifiedDownload(spec,dest,{signal:c.signal,fetchFn:async()=>new Response(content),matches:async(file,s)=>{
    const valid=await fileMatches(file,s);if(file.endsWith('.part'))c.abort();return valid;
  }}),{name:'AbortError'});
  assert.equal(await readFile(dest,'utf8'),'old-file');assert.deepEqual(await readFile(dest+'.part'),content);
});
test('abort interrupts backpressure and awaits writable destruction',async()=>{
  const dest=await temp();await writeFile(dest,'old-file');const c=new AbortController();let closed=false;
  const sink=new Writable({highWaterMark:1,write(_chunk,_enc,_done){c.abort();},destroy(err,done){setTimeout(()=>{closed=true;done(err);},10);}});
  await assert.rejects(verifiedDownload(spec,dest,{signal:c.signal,fetchFn:async()=>new Response(content),writeStream:()=>sink}),{name:'AbortError'});
  assert.equal(closed,true);assert.equal(await readFile(dest,'utf8'),'old-file');
});
test('asynchronous file failure cancels a waiting response body',async()=>{
  const dest=await temp();let cancelled=false;
  const body=new ReadableStream({start(c){c.enqueue(content.subarray(0,1));},cancel(){cancelled=true;}});
  const sink=new Writable({write(_chunk,_enc,done){done(new Error('fake disk failure'));}});
  await assert.rejects(verifiedDownload(spec,dest,{fetchFn:async()=>new Response(body),writeStream:()=>sink}),/disk failure/);
  assert.equal(cancelled,true);
});
test('a stalled HTTP body has a bounded abort and leaves a resumable partial',async()=>{
  const dest=await temp();let cancelled=false;
  const body=new ReadableStream({start(c){c.enqueue(content.subarray(0,5));},cancel(){cancelled=true;}});
  await assert.rejects(verifiedDownload(spec,dest,{fetchFn:async()=>new Response(body),idleTimeoutMs:30}));
  assert.equal(cancelled,true);assert.deepEqual(await readFile(dest+'.part'),content.subarray(0,5));
});
test('oversized HTTP body is refused before writing bytes beyond the pinned size',async()=>{
  const dest=await temp();await writeFile(dest,'old-file');
  await assert.rejects(verifiedDownload(spec,dest,{fetchFn:async()=>new Response(Buffer.alloc(spec.bytes+1))}),/exceeded/);
  assert.equal(await readFile(dest,'utf8'),'old-file');assert.equal((await stat(dest+'.part')).size,0);
});
test('truncated download retains its partial and retries with an exact Range request',async()=>{
  const dest=await temp();await assert.rejects(verifiedDownload(spec,dest,{fetchFn:async()=>new Response(content.subarray(0,3))}),/Incomplete/);
  assert.deepEqual(await readFile(dest+'.part'),content.subarray(0,3));
  await verifiedDownload(spec,dest,{fetchFn:async(_u,o)=>{assert.equal(o.headers.Range,'bytes=3-');return new Response(content.subarray(3),{status:206,headers:{'content-range':`bytes 3-${spec.bytes-1}/${spec.bytes}`}});}});
  assert.deepEqual(await readFile(dest),content);
});
test('non-regular partial is refused without removing it or starting network',async()=>{
  const dest=await temp();await mkdir(dest+'.part');
  await assert.rejects(verifiedDownload(spec,dest,{fetchFn:()=>assert.fail('no network')}),/regular file/);
  assert.equal((await stat(dest+'.part')).isDirectory(),true);
});
