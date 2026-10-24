/** Temp-file/API fixtures only. No Studio, media decoding or generation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createClipFavorites,createClipFavoriteFlagRoute,clipFavoriteFailure} from './clip-favorites.js';

async function fixture(t,options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'aiplay-clip-favorites-'));
  t.after(async () => {
    const relative=path.relative(os.tmpdir(),root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('aiplay-clip-favorites-')) throw Error('Unsafe test cleanup');
    await fs.rm(root,{recursive:true,force:true});
  });
  const dir=path.join(root,'clips'),file=path.join(root,'data','clip-favorites.json');
  await fs.mkdir(dir);
  const names=['one.mp4','two.webm','three.mov','import.png'];
  for (const name of names) await fs.writeFile(path.join(dir,name),`Fixture bytes for ${name}`);
  const opts={file,clipDir:dir,...options},store=createClipFavorites(opts);
  return {root,dir,file,names,store,opts};
}
const badStatus = (status,reason) => error => { const failure=clipFavoriteFailure(error); assert.equal(failure.status,status); if(reason)assert.equal(failure.body.reason,reason); return true; };

test('first read is empty and successful stars persist across new store instances without touching media or lineage',async t => {
  const f=await fixture(t),media=await fs.readFile(path.join(f.dir,'one.mp4'));
  const lineage=path.join(f.root,'clips.json');await fs.writeFile(lineage,'{"meta":{"one.mp4":{"source":"generated"}}}');
  assert.deepEqual(await f.store.read(),new Set());
  await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
  assert.deepEqual(await f.store.set('one.mp4',true),{name:'one.mp4',starred:true});
  assert.deepEqual(await createClipFavorites(f.opts).read(),new Set(['one.mp4']));
  assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),{version:1,starred:['one.mp4']});
  assert.deepEqual(await fs.readFile(path.join(f.dir,'one.mp4')),media);
  assert.equal(await fs.readFile(lineage,'utf8'),'{"meta":{"one.mp4":{"source":"generated"}}}');
  await f.store.set('one.mp4',false);
  assert.deepEqual(await createClipFavorites(f.opts).read(),new Set());
});

test('concurrent requests and store instances serialize fresh read/modify/save without losing other favorites',async t => {
  const f=await fixture(t),other=createClipFavorites(f.opts);
  await Promise.all(f.names.map((name,index)=>(index%2?other:f.store).set(name,true)));
  assert.deepEqual(await f.store.read(),new Set(f.names));
  const ops=[];
  for(let n=0;n<12;n++)ops.push((n%2?other:f.store).set('one.mp4',n%3===0));
  await Promise.all(ops);
  assert.deepEqual(await f.store.read(),new Set(f.names.slice(1)));
  assert.deepEqual(await fs.readdir(path.dirname(f.file)),['clip-favorites.json']);
});

test('idempotent updates acknowledge only existing files and do not rewrite a valid store',async t => {
  const f=await fixture(t);
  await f.store.set('one.mp4',false);
  await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
  await f.store.set('one.mp4',true);const before=await fs.readFile(f.file);
  await f.store.set('one.mp4',true);assert.deepEqual(await fs.readFile(f.file),before);
  await fs.unlink(path.join(f.dir,'one.mp4'));
  await assert.rejects(f.store.set('one.mp4',true),badStatus(404,'clip-missing'));
  assert.deepEqual(await fs.readFile(f.file),before);
});

test('bad names, nonboolean values, missing files and directories are rejected before any favorite save',async t => {
  const f=await fixture(t);
  for(const name of ['',null,'../one.mp4','sub/one.mp4','sub\\one.mp4','C:one.mp4','one.mp4\0','one.txt','CON.mp4','one.mp4 '])
    await assert.rejects(f.store.set(name,true),badStatus(400,'invalid-favorite'));
  for(const value of [undefined,null,1,0,'true',{},[]])await assert.rejects(f.store.set('one.mp4',value),badStatus(400));
  await assert.rejects(f.store.set('missing.mp4',true),badStatus(404));
  await fs.mkdir(path.join(f.dir,'folder.mp4'));
  await assert.rejects(f.store.set('folder.mp4',true),badStatus(404));
  await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});

test('malformed JSON, unknown schemas and bad entries remain byte-exact and cannot be overwritten',async t => {
  const f=await fixture(t);await fs.mkdir(path.dirname(f.file));
  for(const text of ['{"version":1,','null','[]','{"version":2,"starred":[]}',
    '{"version":1,"starred":{}}','{"version":1,"starred":["../outside.mp4"]}',
    '{"version":1,"starred":[],"unexpected":true}']) {
    await fs.writeFile(f.file,text);
    await assert.rejects(f.store.read(),badStatus(409,'favorites-corrupt'));
    await assert.rejects(f.store.set('one.mp4',true),badStatus(409,'favorites-corrupt'));
    assert.equal(await fs.readFile(f.file,'utf8'),text);
  }
  await fs.writeFile(f.file,'{"version":1,"starred":[]}');
  await f.store.set('two.webm',true);
  assert.deepEqual(await f.store.read(),new Set(['two.webm']),'a rejected transaction does not poison the next request');
});

test('a failed atomic replace preserves prior flags, cleans its temporary file and fails the request',async t => {
  const f=await fixture(t);await f.store.set('one.mp4',true);const before=await fs.readFile(f.file);
  const broken=createClipFavorites({...f.opts,replace:async()=>{throw Object.assign(Error('Private disk path details'),{code:'EACCES'});}});
  await assert.rejects(broken.set('two.webm',true),badStatus(500,'favorites-unavailable'));
  assert.deepEqual(await fs.readFile(f.file),before);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)),['clip-favorites.json']);
  await f.store.set('three.mov',true);
  assert.deepEqual(await f.store.read(),new Set(['one.mp4','three.mov']));
});

test('oversized stores are refused before reading their payload and remain untouched',async t => {
  const f=await fixture(t);await fs.mkdir(path.dirname(f.file));
  const bytes=Buffer.alloc(4*1024*1024+1,32);await fs.writeFile(f.file,bytes);
  let reads=0;
  const bounded=createClipFavorites({...f.opts,io:{...fs,readFile:async()=>{reads++;throw Error('Payload must not be read');}}});
  await assert.rejects(bounded.read(),badStatus(409,'favorites-corrupt'));
  await assert.rejects(bounded.set('one.mp4',true),badStatus(409,'favorites-corrupt'));
  assert.equal(reads,0);assert.deepEqual(await fs.readFile(f.file),bytes);
});

test('unreadable stores and failed temporary writes do not become empty or successful updates',async t => {
  const f=await fixture(t);await f.store.set('one.mp4',true);const before=await fs.readFile(f.file);
  const denied=Object.assign(Error('Secret source path'),{code:'EACCES'});
  const unreadable=createClipFavorites({...f.opts,io:{...fs,readFile:async()=>{throw denied;}}});
  await assert.rejects(unreadable.set('two.webm',true),badStatus(500));
  const noWrite=createClipFavorites({...f.opts,io:{...fs,writeFile:async()=>{throw denied;}}});
  await assert.rejects(noWrite.set('two.webm',true),badStatus(500));
  assert.deepEqual(await fs.readFile(f.file),before);
  assert.doesNotMatch(JSON.stringify(clipFavoriteFailure(denied)),/Secret source path/);
});

function routeFixture(favorites) {
  const json=(_res,status,body)=>({status,body});
  const sameOriginLocalJson=req=>/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')
    && (!req.headers.origin||req.headers.origin===`http://${req.headers.host}`);
  return {route:createClipFavoriteFlagRoute({favorites,json,sameOriginLocalJson}),req:{headers:{host:'127.0.0.1:9999','content-type':'application/json'}}};
}
test('the actual flag handler persists UI/MCP bodies and returns the acknowledged boolean',async t => {
  const f=await fixture(t),r=routeFixture(f.store);
  for(const value of [true,false]) {
    const response=await r.route(r.req,{}, {action:'flag',flag:'starred',name:'one.mp4',value});
    assert.deepEqual(response,{status:200,body:{ok:true,name:'one.mp4',starred:value}});
    assert.equal((await createClipFavorites(f.opts).read()).has('one.mp4'),value);
  }
});

test('the actual flag handler rejects invalid fields/origins and propagates missing, corrupt and write failures',async t => {
  const f=await fixture(t),r=routeFixture(f.store),valid={action:'flag',flag:'starred',name:'one.mp4',value:true};
  assert.equal((await r.route({...r.req,headers:{...r.req.headers,origin:'https://outside.test'}},{},valid)).status,403);
  assert.equal((await r.route({...r.req,headers:{...r.req.headers,'content-type':'text/plain'}},{},valid)).status,403);
  for(const body of [{...valid,value:'true'},{...valid,flag:'pinned'},{...valid,extra:true},{...valid,name:'../one.mp4'}])
    assert.equal((await r.route(r.req,{},body)).status,400);
  assert.equal((await r.route(r.req,{}, {...valid,name:'gone.mp4'})).status,404);
  await fs.mkdir(path.dirname(f.file));await fs.writeFile(f.file,'broken');
  assert.equal((await r.route(r.req,{},valid)).status,409);
  const fail=routeFixture({set:async()=>{throw Error('Private path');}});
  const response=await fail.route(fail.req,{},valid);
  assert.equal(response.status,500);assert.doesNotMatch(response.body.error,/Private path/);
});

test('the existing clips route reads favorites once, labels every row and delegates flag changes',async () => {
  const source=readFileSync(new URL('./index.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('if (p === "/api/clips" && req.method !== "POST")');
  const end=source.indexOf('\n    /**',start);
  const listing=source.slice(start,end),calls=[];
  const favoriteStore={read:async()=>{calls.push('read');return new Set(['two.webm']);}};
  const run=new Function('clipFavorites','clipFavoriteFailure','readdir','stat','CLIP_DIR','path','library','clipMeta','clipTimes','config','enhanceLimitBytes','json',
    `return async function(req,res){ const p='/api/clips'; ${listing} };`)(
    favoriteStore,clipFavoriteFailure,
    async()=>['one.mp4','two.webm'],async()=>({size:17,mtimeMs:12}),'/fixture',path,{meta:new Map()},new Map(),new Map(),{video:{enabled:true}},()=>123,
    (_r,status,body)=>({status,body}));
  const response=await run({method:'GET'},{});
  assert.equal(response.status,200);assert.deepEqual(calls,['read']);
  assert.deepEqual(response.body.clips.map(row=>[row.name,row.starred]),[['one.mp4',false],['two.webm',true]]);
  favoriteStore.read=async()=>{throw Error('Private storage path');};
  const failed=await run({method:'GET'},{});
  assert.equal(failed.status,500);assert.equal(failed.body.clips,undefined);
  assert.equal(failed.body.reason,'favorites-unavailable');assert.doesNotMatch(failed.body.error,/Private storage path/);
  const post=source.slice(source.indexOf('if (p === "/api/clips" && req.method === "POST")'));
  assert.match(post,/const b = await readBody\(req\);\s*if \(b\.action === 'flag'\) return clipFavoriteFlagRoute\(req,res,b\);/);
  assert.match(source,/createClipFavorites\(\{ file:path\.join\(config\.paths\.appData,'clip-favorites\.json'\), clipDir:CLIP_DIR \}\)/);
});
