import test from 'node:test';import assert from 'node:assert/strict';
import {AVATAR_EXAMPLE,downloadAvatarExample,createExampleInstaller} from './avatar-example.js';
test('curated example refuses modified and over-budget bytes before import',async()=>{
 await assert.rejects(downloadAvatarExample(async()=>new Response('changed')),/size\/hash/);
 let cancelled=false;const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(AVATAR_EXAMPLE.bytes+1));},cancel(){cancelled=true;}});
 await assert.rejects(downloadAvatarExample(async()=>new Response(body)),/pinned size/);assert.equal(cancelled,true);
});
test('an installed exact model is revalidated without a download, even for concurrent callers',async()=>{
 let inspections=0;const row={id:'existing',inspection:{profile:'vrm',sha256:AVATAR_EXAMPLE.sha256}};
 const install=createExampleInstaller({list:async()=>[row],inspect:async()=>{inspections++;return row;}},()=>{throw Error('unexpected network');});
 assert.deepEqual(await Promise.all([install('a'),install('b')]),[row,row]);assert.equal(inspections,1);
});

const installed=id=>({id,inspection:{profile:'vrm',sha256:AVATAR_EXAMPLE.sha256}});
const changed=()=>Object.assign(new Error('Avatar changed on disk; import the changed file as a new version.'),{status:409});

test('missing or hash-changed imports are preserved while a fresh download still passes the pin gate',async()=>{
 for(const error of [Object.assign(new Error('Avatar not found.'),{status:404}),Object.assign(new Error('Missing GLB.'),{code:'ENOENT'}),changed()]){
  const old=Object.freeze(installed('old')),before=JSON.stringify(old);let downloads=0,imports=0;
  const service={list:async()=>[old],inspect:async()=>{throw error;},importAsset:async()=>{imports++;throw Error('Unpinned data reached import');}};
  const install=createExampleInstaller(service,async(url,options)=>{
   downloads++;assert.equal(url,AVATAR_EXAMPLE.url);assert.equal(options.redirect,'error');return new Response('modified upstream');
  });
  await assert.rejects(install('repair'),/size\/hash/);
  assert.equal(downloads,1);assert.equal(imports,0);assert.equal(JSON.stringify(old),before);
  assert.deepEqual(await service.list(),[old]);
 }
});

test('a later intact installed copy is reused after an earlier damaged one without network access',async()=>{
 const old=installed('damaged'),good=installed('intact'),seen=[];
 const install=createExampleInstaller({list:async()=>[old,good],inspect:async id=>{seen.push(id);if(id===old.id)throw changed();return good;}},()=>{throw Error('Unexpected download');});
 assert.deepEqual(await install('repair'),good);assert.deepEqual(seen,['damaged','intact']);
});

test('general validation, identity conflicts and I/O failures stay visible and never trigger download',async()=>{
 for(const error of [Object.assign(new Error('Invalid skin.'),{status:422}),Object.assign(new Error('Avatar identity mismatch.'),{status:409}),Object.assign(new Error('Permission denied.'),{code:'EACCES'}),new Error('Validator unavailable')]){
  let downloads=0;
  const install=createExampleInstaller({list:async()=>[installed('old')],inspect:async()=>{throw error;}},async()=>{downloads++;return new Response('anything');});
  await assert.rejects(install('repair'),actual=>actual===error);assert.equal(downloads,0);
 }
});

test('concurrent repairs share one pinned attempt and a failed attempt can be retried',async()=>{
 let downloads=0,inspections=0;
 const install=createExampleInstaller({list:async()=>[installed('old')],inspect:async()=>{inspections++;throw changed();}},async()=>{downloads++;return new Response('modified upstream');});
 const results=await Promise.allSettled([install('first'),install('second')]);
 assert.ok(results.every(result=>result.status==='rejected'&&/size\/hash/.test(result.reason.message)));
 assert.equal(downloads,1);assert.equal(inspections,1);
 await assert.rejects(install('retry'),/size\/hash/);assert.equal(downloads,2);assert.equal(inspections,2);
});
